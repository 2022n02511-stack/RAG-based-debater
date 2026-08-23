# Socrates — Web-Based RAG Application

A browser-based Retrieval-Augmented Generation (RAG) application that lets you have a
grounded, in-character conversation with a PDF — as if you were speaking directly with
the author. Ask questions, push back, and the system defends its answers using the
actual retrieved text, not general knowledge dressed up as the source.

Supports both **text** and **voice** interaction, live-streamed LLM responses over a
WebSocket, a visible evidence panel, and multiple LLM providers through a common
interface.

> Inspired by Socrates' critique of writing in Plato's *Phaedrus*: a written text cannot
> answer back. This project is an attempt to give it a voice — first as a CLI tool, and
> now as a proper interface for it.

This is the web successor to an earlier CLI-based version of the same idea
([Talking Books — CLI RAG Application](https://github.com/2022n02511-stack/CLI-Based-RAG-Application)).
The RAG core — chunking, retrieval, grounding, persona — carries over unchanged; what's
new here is a FastAPI backend, a WebSocket-driven browser UI, PDF upload instead of a
hardcoded path, and a live evidence panel.

---

## Overview

This project explores the core engineering behind a real RAG application, built by hand
rather than through a high-level framework, in order to actually understand each layer
— now wired end-to-end into a browser instead of a terminal:

**PDF Upload → Chunking → Vector Database → Retrieval → LLM → WebSocket Streaming → Text / Audio**

Current capabilities:

- PDF upload and ingestion directly from the browser, no code changes needed per document
- Retrieval-threshold filtering, so the system only answers from the document when the
  retrieved passages are genuinely relevant — otherwise it clearly flags that it's
  answering from general knowledge instead
- An "author persona" system prompt that stays in character, defends arguments when
  challenged, and adapts tone without abandoning its grounding rules
- Multiple LLM providers (Mistral, Google Gemini) behind a single common interface,
  switchable per message from the UI
- Token-level streaming over a WebSocket, rendered live as the model generates
- Text mode and voice mode, selectable per message rather than fixed at session start
- Sentence-level text-to-speech with an async producer/consumer pipeline, so playback
  doesn't wait for the full response to finish generating
- A live evidence panel showing exactly which passages (page + snippet) grounded each
  answer
- Interruptible generation — a response can be stopped mid-stream from the UI
- Conversation memory across turns

---

## Architecture

```text
                         ┌─────────────────┐
                         │   PDF (upload)  │
                         └────────┬────────┘
                                  │  POST /upload
                                  ▼
                         ┌─────────────────┐
                         │  Text Extraction│
                         │     (PyPDF)     │
                         └────────┬────────┘
                                  │
                                  ▼
                       ┌─────────────────────┐
                       │   Text Chunking     │
                       │ RecursiveCharacter  │
                       │      Splitter       │
                       └──────────┬──────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │    ChromaDB     │
                         │  Vector Store   │
                         └────────┬────────┘
                                  │
                        User Question (WebSocket)
                                  │
                                  ▼
                       ┌─────────────────────┐
                       │  Similarity Search  │
                       │      ChromaDB       │
                       │  + Distance Filter  │
                       └──────────┬──────────┘
                                  │
                                  ▼
                       ┌─────────────────────┐
                       │     RAG Prompt      │
                       │                     │
                       │  Context + Question │
                       │   + Conversation    │
                       └──────────┬──────────┘
                                  │
                                  ▼
                 ┌────────────────────────────────┐
                 │          LLM Provider          │
                 │        (common interface)      │
                 │     ┌────────┐   ┌────────┐    │
                 │     │Mistral │   │ Gemini │    │
                 │     └────────┘   └────────┘    │
                 └───────────────┬────────────────┘
                                 │
                                 ▼
                      Streamed Tokens (asyncio.Queue)
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
              ┌───────────┐           ┌──────────────┐
              │ Text Mode │           │  Voice Mode  │
              └─────┬─────┘           └──────┬───────┘
                    │                        │
                    ▼                        ▼
             Browser (WebSocket)        Sentence
             live token render           Detection
                    │                        │
                    ▼                        ▼
             Evidence Panel                 TTS
             (page + snippet)          (edge-tts)
                                             │
                                             ▼
                                        Audio Queue
                                     (sequential playback
                                      over WebSocket)
```

---

## Features

### RAG Pipeline

- Extracts text from uploaded PDF documents, page by page
- Splits documents into overlapping chunks to preserve cross-page arguments
- Stores chunks in ChromaDB, batched on upsert
- Performs similarity-based retrieval (top 3 nearest chunks per question)
- Filters retrieved chunks by distance threshold — if nothing relevant is found, the
  system says so explicitly instead of forcing a connection
- Injects only genuinely relevant passages into the LLM prompt, along with running
  conversation history

### Grounded, In-Character Responses

- Speaks as the intellectual voice of the document's author, in first person
- Defends the text's arguments when challenged, without folding under pressure alone
- Distinguishes clearly between claims grounded in the retrieved passages and general
  knowledge used to fill a gap — the latter is always flagged, never presented as if
  it were sourced from the document
- Adapts tone on request (politeness, simplicity) without treating that as a concession
  on the argument itself
- Handles greetings, farewells, meta-questions, and hostile input gracefully while
  staying in character

### Multiple LLM Providers

Supported via a common streaming interface, so the rest of the application never has to
know which provider is active:

- **Mistral** (`mistral-small-latest`)
- **Google Gemini** (`gemini-3.6-flash`)

Provider is chosen from a dropdown and can change from one message to the next within
the same session.

### Streaming Responses

LLM responses are streamed token by token over a WebSocket rather than waiting for the
full response, so the browser can render text live — and, in voice mode, begin speaking
— before generation finishes. Sending a new question while one is still streaming
cancels the in-flight task server-side.

### Text Mode

Tokens arrive over the WebSocket and are rendered live into the chat pane as they
stream, with a lightweight sanitized markdown renderer (bold only; everything else is
escaped first).

### Voice Mode

1. Record a spoken question from the microphone in the browser
2. Transcribe it server-side with Whisper (`POST /transcribe`)
3. Retrieve relevant passages and generate a grounded response
4. Split the streamed response into sentences as they complete
5. Generate speech for each sentence and push it to the client over the WebSocket
6. Play queued audio continuously on the client, strictly one clip at a time, so
   playback for later sentences never overlaps or overtakes an earlier one

### Evidence Panel

Every grounded answer is paired with the page numbers and text snippets that were
actually retrieved and used to produce it, rendered in a dedicated panel alongside the
chat.

### Interruptible Generation

The send button becomes a stop button while a response is streaming. Clicking it halts
audio playback client-side and closes/reopens the WebSocket, which cancels the
in-flight backend task rather than letting it run to completion unseen.

---

## Tech Stack

| Component         | Technology                             |
|--------------------|----------------------------------------|
| Language           | Python                                  |
| Backend framework  | FastAPI (REST + WebSockets)             |
| RAG                | Custom pipeline                         |
| Vector Database    | ChromaDB                                |
| PDF Processing     | PyPDF                                   |
| Text Splitting     | LangChain Text Splitters                |
| LLM Providers      | Mistral, Google Gemini                  |
| Speech-to-Text     | Local Whisper (faster-whisper)          |
| Text-to-Speech     | edge-tts                                |
| Frontend           | Vanilla HTML / CSS / JS, WebSocket client |
| Concurrency        | `asyncio`, `asyncio.Queue`, thread executor |
| Configuration      | python-dotenv                           |

---

## Project Structure

```text
RAG-based-debater/
│
├── main.py               # FastAPI app: upload, transcribe, and /chat WebSocket endpoint
├── stream_llm.py          # Common streaming interface across LLM providers
├── system_prompt.txt      # Author-persona system prompt
├── requirements.txt
├── .env.example
├── .gitignore
├── templates/
│   └── index.html          # Two-pane chat + evidence panel shell
└── static/
    ├── css/
    │   └── style.css       # ASCII/terminal theme, CSS variables, light + dark
    └── js/
        └── app.js          # WebSocket client, streaming render, audio queue, mic capture
```

**`main.py`** — PDF upload and text extraction, chunking, ChromaDB setup, retrieval,
prompt construction, the synchronous RAG worker run in a thread executor, and the
`/chat` WebSocket endpoint that bridges that worker back to the browser.

**`stream_llm.py`** — Exposes a single function, `stream_llm(provider, system_prompt, prompt)`,
that returns a plain stream of text regardless of which provider is selected. The rest
of the application never needs to know provider-specific request or response formats.

**`system_prompt.txt`** — The author-persona instructions, including grounding rules,
tone handling, and out-of-scope behavior — unchanged from the CLI version.

**`templates/index.html`** / **`static/js/app.js`** / **`static/css/style.css`** — The
piece that didn't exist in the CLI version: an upload box, a two-pane chat + evidence
layout, a WebSocket client that renders streamed tokens live, queues and plays TTS
audio in order, and handles theme, mic capture, and interrupting a response mid-stream.

---

## How the RAG Pipeline Works

```text
User:
"What does existentialism say about freedom?"
```

1. The question arrives over the WebSocket along with the chosen provider and mode.
2. It's embedded and sent to ChromaDB as a similarity query (top 3 results).
3. Chunks with a distance above the threshold (`0.9`) are discarded as not relevant.
4. Remaining chunks are inserted into the prompt:

```text
Context:
<retrieved, relevant passages only>

Conversation history:
<previous turns>

Question:
"What does existentialism say about freedom?"
```

5. The prompt is sent to the selected provider and streamed back token by token.
6. If no chunks passed the relevance filter, the model is explicitly told no relevant
   passages were found, so it answers — if at all — clearly flagged as outside the
   source document.
7. Once generation finishes, the page numbers and snippets of the chunks that were
   actually used are sent to the browser to populate the evidence panel.

---

## Audio Pipeline

Voice mode runs the RAG worker in a background thread, with an `asyncio.Queue` bridging
it back to the WebSocket's event loop — an async equivalent of the CLI version's
producer/consumer thread pipeline.

**Producer (worker thread)** — reads the streamed LLM output, buffers it until a full
sentence is detected, and pushes that sentence onto the queue for TTS generation.

**Consumer (event loop)** — pulls each sentence off the queue, generates speech for it
with edge-tts, and sends the resulting audio URL to the browser over the WebSocket as
soon as it's ready.

**Client-side queue** — the browser queues incoming audio URLs and plays them strictly
one at a time, so playback stays in the order the sentences were spoken even though
generation for later sentences can start before earlier ones finish playing.

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/2022n02511-stack/RAG-based-debater.git
cd RAG-based-debater
```

### 2. Create a virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure API keys

Copy `.env.example` to `.env` and fill in your own keys:

```text
MISTRAL_API_KEY=your_mistral_api_key
GEMINI_API_KEY=your_gemini_api_key
```

`.env` is excluded from version control via `.gitignore` — never commit real API keys.
You only need a key for the provider(s) you actually plan to use.

`ffmpeg` also needs to be available on your system PATH, since `faster-whisper` relies
on it for audio decoding.

---

## Running the Application

```bash
uvicorn main:app --reload
```

Then open **http://127.0.0.1:8000** in your browser.

1. Upload a PDF using the box at the top of the page.
2. Once ingestion finishes, the chat input and provider dropdown unlock.
3. Pick a provider (Mistral or Gemini).
4. Ask a question by typing, or record one with the mic button.
5. Watch the response stream in live, with sources populating the evidence panel on
   the right as it completes.
6. In voice mode, the response is also read back sentence by sentence as it streams.

### Example — Text Mode

```text
Provider: mistral
Mode: text

You:
> What does existentialism mean?

Socrates:
At its core, existentialism holds that existence precedes essence — we are not
born with a fixed nature, but define ourselves through our choices...

Evidence panel:
# page 12 — "...to say that existence precedes essence means that..."
# page 14 — "...man is nothing else but what he makes of himself..."
```

### Example — Voice Mode

```text
Provider: gemini
Mode: voice

[Recording...]
[Recording stopped. Transcribing...]

You said: "Explain existentialism"

[Streaming response]
[Sentence 1 ready — playing]
[Sentence 2 generating while sentence 1 plays]
```

---

## Current Limitations

- Single shared document collection — no per-user or multi-document isolation
- Conversation history is in-memory and process-wide, not per-session or persistent
- Retrieval `top_k` and the relevance threshold are fixed in code, not exposed in the UI
- No authentication
- Speech-to-text is not streamed in real time (recording is a fixed, blocking step)
- Audio pacing operates at the sentence level, not the word level
- TTS voice, rate, and pitch are hardcoded rather than user-selectable

---

## Future Improvements

**RAG** — multiple document support, document management, reranking, metadata-based
filtering, and a persistent, per-session vector store.

**Voice** — streaming speech-to-text, lower-latency TTS, word-level audio pacing, voice
activity detection instead of fixed-duration recording, and a selectable TTS voice.

**Interface** — configurable retrieval parameters from the UI, per-session (not
process-wide) conversation history, and multi-document switching without restarting the
app.

**LLM providers** — the existing provider abstraction makes it straightforward to add
further providers (e.g. OpenAI, Anthropic) later without changing the rest of the
application.

---

## Development Phases

1. **RAG foundation** — PDF ingestion, chunking, vector search, context retrieval, LLM generation
2. **Streaming** — LLM streaming, sentence detection, streaming text output
3. **Voice** — speech-to-text, text-to-speech, producer/consumer audio queue
4. **Multi-provider architecture** — common provider interface, SDK-based streaming
5. **Web application** *(this project)* — FastAPI backend, WebSocket streaming, PDF
   upload, browser chat interface, live evidence panel, interruptible generation

---

## What I Learned

Moving the CLI version into a browser meant rebuilding the streaming and audio layers
around `asyncio` instead of blocking calls and threads, while keeping the actual RAG
logic — chunking, retrieval, grounding, persona — exactly as it was. Areas explored in
depth on top of the original project:

- Bridging a synchronous, blocking RAG worker (running in a thread executor) back into
  an async WebSocket loop via `asyncio.Queue` and `run_coroutine_threadsafe`
- Designing a WebSocket message protocol (`token`, `audio`, `sources`, `done`) that lets
  the frontend stay a thin renderer instead of re-implementing any RAG logic
- Making generation actually interruptible — not just visually, but by tearing down and
  reopening the connection so the backend task is genuinely cancelled
- Keeping strictly-ordered audio playback on the client when sentence-level TTS
  generation and playback are happening concurrently, not sequentially
- Prompt engineering for a persona that stays grounded, holds its position under
  challenge, and clearly flags claims that aren't sourced from the retrieved text
  (carried over from the CLI version, re-validated against the same adversarial tests)

---

## License

This project is intended for educational and portfolio purposes.
