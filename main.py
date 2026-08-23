import os
import uuid
import asyncio
import re
from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect, Response, status
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from langchain_text_splitters import RecursiveCharacterTextSplitter
import chromadb
from pypdf import PdfReader
from stream_llm import stream_llm
from faster_whisper import WhisperModel
import edge_tts
import aiofiles
from edge_tts.exceptions import NoAudioReceived

#making sure dirs exist
os.makedirs("uploads", exist_ok=True)
os.makedirs("static/audio", exist_ok=True)

#defining tts function
async def generate_tts(text: str) -> str | None:
    cleaned_text = re.sub(r'\s+', ' ', text).strip()
    
    if not cleaned_text or not re.search(r'\w', cleaned_text):
        return None

    filename = f"{uuid.uuid4()}.mp3"
    filepath = f"static/audio/{filename}"

    try:
        comm = edge_tts.Communicate(
            cleaned_text, 
            voice="en-US-ChristopherNeural", 
            rate="-8%", 
            pitch="-4Hz"
        )
        
        async with aiofiles.open(filepath, "wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    await f.write(chunk["data"])

        return filename

    except NoAudioReceived:
        return None
    except Exception as e:
        print(f"TTS Generation Error: {e}")
        return None

#loading system prompt
with open("system_prompt.txt") as f:
    system_prompt = f.read()

#initiate ChromaDB
client = chromadb.PersistentClient(path="./chroma_data")
collection = client.get_or_create_collection(name="phil_text")

conversations = []

app = FastAPI(title="Talking Books")

@app.get("/favicon.ico", include_in_schema=False)
async def get_favicon():
    return Response(status_code=status.HTTP_204_NO_CONTENT)

#mount static folder and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html", {})

#defining upload PDF
@app.post("/upload")
async def upload_pdf(file: UploadFile):
    contents = await file.read()

    with open(f"uploads/{file.filename}", "wb") as f:
        f.write(contents)

    reader = PdfReader(f"uploads/{file.filename}")

    #chunking strategy
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=150,
        length_function=len,
        separators=["\n\n", "\n", ". ", " "]
    )

    chunks = []
    for page_num, page in enumerate(reader.pages, start=1):
        text = page.extract_text()
        if text:
            for chunk in text_splitter.split_text(text):
                chunks.append({"text": chunk, "text_id": len(chunks) + 1, "page": page_num})

    documents = [item["text"] for item in chunks]

    ids = [f"chunk_{item['text_id']}" for item in chunks]

    metadatas = [{"page": item["page"]} for item in chunks]

    batch_size = 50
    for i in range(0, len(chunks), batch_size):
        collection.upsert(
            documents=documents[i:i + batch_size],
            ids=ids[i:i + batch_size],
            metadatas=metadatas[i:i + batch_size]
        )

    return {"status": "ok", "filename": file.filename, "chunks_ingested": len(chunks)}

#define STT model
whisper_model = WhisperModel("base")

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile):
    contents = await file.read()

    with open("temp_audio.webm", "wb") as f:
        f.write(contents)

    segments, info = whisper_model.transcribe("temp_audio.webm", language="en")
    text = " ".join([segment.text for segment in segments]).strip()

    return {"text": text}    

# Define synchronous worker pipeline
def run_con_rag_sync(question: str, provider: str, mode: str, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop):
    result = collection.query(query_texts=[question], n_results=3, include=["documents", "distances", "metadatas"])

    relevant_chunks = []
    for doc, dist, meta in zip(result["documents"][0], result["distances"][0], result["metadatas"][0]):
        if dist < 0.9:
            relevant_chunks.append({"text": doc, "page": meta["page"]})

    if relevant_chunks:
        context_block = "\n\n".join(f"Context_{i+1}: {c['text']}" for i, c in enumerate(relevant_chunks))
    else:
        context_block = "No relevant passages were found for this question. You MUST treat this as out-of-scope — do not answer with unflagged confidence even if you have general knowledge on the topic."

    prompt = f"""
        Answer the question using the context below.
        Context: {context_block}
        Conversation history: {conversations}
        Question: {question}
    """

    conversations.append({"role": "user", "content": question})

    all_res = ""
    sentence_buffer = ""

    for content in stream_llm(provider, system_prompt, prompt): 
        all_res += content
        sentence_buffer += content
        
        # Stream text token live to frontend
        asyncio.run_coroutine_threadsafe(
            queue.put({"type": "token", "content": content}), loop
        )

        # Chunk audio by complete sentences
        # Chunk audio by complete sentences safely without losing text
        if mode == "voice":
            # Match complete sentences ending in punctuation followed by space or newline
            matches = list(re.finditer(r'.+?[.!?]+(?=\s+|$)', sentence_buffer, re.DOTALL))
            if matches:
                last_end = 0
                for match in matches:
                    sentence = match.group(0).strip()
                    if sentence:
                        asyncio.run_coroutine_threadsafe(
                            queue.put({"type": "tts_chunk", "text": sentence}), loop
                        )
                    last_end = match.end()
                # Keep only unparsed trailing text in the buffer
                sentence_buffer = sentence_buffer[last_end:]

    # Flush any remaining text in the buffer at the end
    if mode == "voice" and sentence_buffer.strip():
        asyncio.run_coroutine_threadsafe(
            queue.put({"type": "tts_chunk", "text": sentence_buffer.strip()}), loop
        )

    conversations.append({"role": "assistant", "content": all_res})
    sources = [{"page": c["page"], "text": c["text"][:200]} for c in relevant_chunks]

    asyncio.run_coroutine_threadsafe(
        queue.put({"type": "complete", "response": all_res, "sources": sources}), loop
    )

#defining chat endpoint
@app.websocket("/chat")
async def chat_endpoint(websocket: WebSocket):
    await websocket.accept()
    current_task = None

    async def handle_question(question, provider, mode):
        try:
            queue = asyncio.Queue()
            loop = asyncio.get_running_loop()

            executor_task = loop.run_in_executor(
                None, run_con_rag_sync, question, provider, mode, queue, loop
            )

            sources = []

            while True:
                item = await queue.get()
    
                if item["type"] == "token":
                    await websocket.send_json({"type": "token", "content": item["content"]})
                    await asyncio.sleep(0)

                elif item["type"] == "tts_chunk":
                    # Await generate_tts directly so audio chunks are processed 
                    # strictly sequentially in the order they were spoken by the LLM
                    try:
                        filename = await generate_tts(item["text"])
                        if filename:
                            await websocket.send_json({"type": "audio", "url": f"/static/audio/{filename}"})
                    except Exception as e:
                        print(f"Error generating sequential TTS: {e}")

                elif item["type"] == "complete":
                    sources = item["sources"]
                    break

            await executor_task

            # Push sources metadata and completion signal
            await websocket.send_json({"type": "sources", "sources": sources})
            await websocket.send_json({"type": "done"})

        except asyncio.CancelledError:
            pass

    try:
        while True:
            data = await websocket.receive_json()

            # Cancel active question handler if new request comes in
            if current_task and not current_task.done():
                current_task.cancel()

            question = data["question"]
            provider = data["provider"]
            mode = data.get("mode", "text")

            current_task = asyncio.create_task(handle_question(question, provider, mode))

    except WebSocketDisconnect:
        if current_task and not current_task.done():
            current_task.cancel()