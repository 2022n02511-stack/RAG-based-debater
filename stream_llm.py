import os

from mistralai.client import Mistral
from google import genai
from dotenv import load_dotenv

load_dotenv()


mistral_client = Mistral(
    api_key=os.environ["MISTRAL_API_KEY"]
)


gemini_client = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"]
)

def stream_mistral(system_prompt, prompt):

    stream = mistral_client.chat.stream(
        model='mistral-small-latest',
        messages=[
            {
                "role" : "system",
                "content" : system_prompt
            },
            {
                "role" : "user",
                "content" : prompt
            }
        ],
        temperature=0.8
    )

    with stream as events:
        for event in events:

            content = event.data.choices[0].delta.content

            if content:
                yield content



def stream_gemini(system_prompt, prompt):

    chat = gemini_client.chats.create(
        model="gemini-3.6-flash",
        config={
            "system_instruction": system_prompt,
            "temperature": 0.8
        }
    )

    response = chat.send_message_stream(prompt)

    for chunk in response:
        if chunk.text:
            yield chunk.text             


def stream_llm(provider, system_prompt, prompt):

    if provider == "mistral":

        yield from stream_mistral(
            system_prompt,
            prompt
        )

    else:
        yield from stream_gemini(
            system_prompt, prompt
        )    



