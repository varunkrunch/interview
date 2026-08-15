"""
Interview Copilot backend.

Bridges: browser (Electron overlay) --audio(PCM16)--> this server --> STT provider (streaming)
                                                                    --> on finalized question --> LLM provider (streaming) --> back to overlay

Provider-agnostic: set STT_PROVIDER and LLM_PROVIDER in .env to switch without code changes.
  STT_PROVIDER = deepgram | openai
  LLM_PROVIDER = gemini | groq | anthropic | openai | ollama

Audio/transcription is now decoupled from the connection itself: the websocket connects
and is ready for typed questions / screenshots immediately. Speech transcription only
starts when the client explicitly sends a 'start_audio' message (i.e. when the user
clicks Start), and stops cleanly on 'stop_audio' — so testing screenshots or typed
questions never triggers STT reconnect noise or disconnects.

Each session also keeps a running conversation history (like a chat thread) so follow-up
questions can reference earlier answers in the same session.

Run with:
    uvicorn main:app --host 127.0.0.1 --port 8765
"""

import asyncio
import io
import json
import os

import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local personal app only — not exposed to the internet
    allow_methods=["*"],
    allow_headers=["*"],
)

STT_PROVIDER = os.environ.get("STT_PROVIDER", "deepgram").lower()
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").lower()

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_TEXT_MODEL = os.environ.get("OLLAMA_TEXT_MODEL", "llama3.2")
OLLAMA_VISION_MODEL = os.environ.get("OLLAMA_VISION_MODEL", "llava:7b")

MAX_HISTORY_TURNS = 10  # keep last N (question, answer) pairs per session

DEEPGRAM_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?encoding=linear16&sample_rate=24000&channels=1"
    "&punctuate=true&interim_results=true&endpointing=500"
)

OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1"

anthropic_client = None
openai_client = None
gemini_client = None
groq_client = None
ollama_client = None

if LLM_PROVIDER == "anthropic" and ANTHROPIC_API_KEY:
    from anthropic import AsyncAnthropic
    anthropic_client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

if LLM_PROVIDER == "openai" and OPENAI_API_KEY:
    from openai import AsyncOpenAI
    openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)

if LLM_PROVIDER == "gemini" and GEMINI_API_KEY:
    from google import genai
    gemini_client = genai.Client(api_key=GEMINI_API_KEY)

if LLM_PROVIDER == "groq" and GROQ_API_KEY:
    from openai import AsyncOpenAI
    groq_client = AsyncOpenAI(api_key=GROQ_API_KEY, base_url="https://api.groq.com/openai/v1")

if LLM_PROVIDER == "ollama":
    from ollama import AsyncClient
    ollama_client = AsyncClient(host=OLLAMA_BASE_URL)


def build_system_prompt(resume: str, jd: str, extra_knowledge: str = "", answer_length: str = "concise",
                         answer_tone: str = "professional", custom_instructions: str = "",
                         experience_level: str = "", target_role: str = "") -> str:
    length_guides = {
        "concise": "3-6 sentences for behavioral questions, or working code/steps for technical ones. Never pad with filler.",
        "balanced": "a solid paragraph or two for behavioral questions, or working code with explanation for technical ones — enough detail to sound thorough without rambling.",
        "detailed": "a thorough, well-structured answer covering multiple angles — still speakable out loud, but don't hold back on depth for technical or behavioral questions.",
    }
    tone_guides = {
        "professional": "Professional and measured.",
        "casual": "Warm and conversational, like talking to a colleague.",
        "confident": "Direct and confident, leading with the strongest point first.",
    }
    experience_guides = {
        "fresher": (
            "The candidate is a fresher/recent graduate with little to no full-time work "
            "experience. Frame answers around academic projects, internships, coursework, "
            "personal/side projects, and genuine eagerness to learn — do NOT claim years of "
            "professional experience or production-scale impact they don't have. It's fine "
            "to say things like 'in my project, I...' or 'while learning X, I...'. Confidence "
            "should come from depth of understanding and enthusiasm, not fabricated seniority."
        ),
        "junior": (
            "The candidate has roughly 1-3 years of professional experience. Frame answers "
            "around real but still-developing hands-on experience — concrete contributions "
            "to real projects/teams, without overstating ownership of large-scale decisions "
            "typically owned by more senior engineers."
        ),
        "mid": (
            "The candidate has roughly 3-6 years of professional experience. Frame answers "
            "around solid ownership of features/systems, some mentoring, and informed "
            "trade-off decisions — competent and independent, not necessarily leading "
            "org-wide initiatives."
        ),
        "senior": (
            "The candidate is senior/experienced (6+ years or a leadership-level role). Frame "
            "answers around ownership at scale, architectural trade-offs, mentoring/leading "
            "others, and business impact — confident, big-picture framing is appropriate."
        ),
    }

    parts = [
        "You are a live interview answer assistant. The user is in a real-time job "
        "interview and needs a spoken-style answer FAST.",
        "Rules:",
        "- Answer directly, first person, as if the candidate is speaking.",
        f"- Length: {length_guides.get(answer_length, length_guides['concise'])}",
        f"- Tone: {tone_guides.get(answer_tone, tone_guides['professional'])}",
        "- Ground answers in the candidate's actual background below — do not invent "
        "experience that isn't supported by it.",
        "- If the question is ambiguous, give the most likely useful answer rather than "
        "asking for clarification (there's no time to ask back).",
        "- You're in an ongoing conversation — earlier questions/answers in this session "
        "are included below for context. Use them naturally (e.g. if asked to elaborate "
        "or clarify something from a moment ago).",
    ]
    if experience_level and experience_level in experience_guides:
        parts.append(f"- Experience level: {experience_guides[experience_level]}")
    if target_role:
        parts.append(
            f"- Target role/field: {target_role}. Use vocabulary, priorities, and examples "
            "relevant to this specific field rather than generic answers."
        )
    if custom_instructions:
        parts.append(f"- Additional instructions from the candidate: {custom_instructions}")

    parts.append(f"\nCANDIDATE RESUME:\n{resume or '(not provided)'}")
    parts.append(f"\nJOB DESCRIPTION:\n{jd or '(not provided)'}")
    if extra_knowledge:
        parts.append(f"\nADDITIONAL BACKGROUND / THINGS ABOUT THE CANDIDATE NOT IN THE RESUME:\n{extra_knowledge}")

    return "\n".join(parts)


def screenshot_prompt(count: int) -> str:
    if count == 1:
        return (
            "This screenshot shows a problem from a live technical interview (could be "
            "a coding problem, a system design question, a diagram, or written text). "
            "Identify the problem and solve it. For coding problems, give working code "
            "with a brief explanation. For conceptual questions, give a clear, direct "
            "answer suited for speaking out loud."
        )
    return (
        f"These {count} screenshots were captured in sequence while scrolling through a "
        "problem shown during a live technical interview — together they cover content "
        "that didn't fit on one screen. Reconstruct the full problem from all screenshots "
        "combined (ignore overlapping/repeated content between consecutive frames), then "
        "solve it. For coding problems, give working code with a brief explanation. For "
        "conceptual questions, give a clear, direct answer suited for speaking out loud."
    )


class Session:
    def __init__(self, client_ws: WebSocket):
        self.client_ws = client_ws
        self.resume = ""
        self.jd = ""
        self.extra_knowledge = ""
        self.answer_length = "concise"
        self.answer_tone = "professional"
        self.custom_instructions = ""
        self.experience_level = ""
        self.target_role = ""
        self.system_prompt = build_system_prompt("", "")
        self.stt_ws = None
        self.stt_task = None
        self.last_transcript = ""
        self._partial_transcript = ""  # in-progress, not-yet-finalized speech
        self.history = []  # list of {"role": "user"|"assistant", "content": str}

    def rebuild_system_prompt(self):
        self.system_prompt = build_system_prompt(
            self.resume, self.jd, self.extra_knowledge,
            self.answer_length, self.answer_tone, self.custom_instructions,
            self.experience_level, self.target_role,
        )

    # ---------------- conversation history ----------------

    def add_to_history(self, role: str, content: str):
        self.history.append({"role": role, "content": content})
        max_messages = MAX_HISTORY_TURNS * 2
        if len(self.history) > max_messages:
            self.history = self.history[-max_messages:]

    def clear_history(self):
        self.history = []
        self.last_transcript = ""
        self._partial_transcript = ""

    # ---------------- audio lifecycle (decoupled from the connection itself) ----------------

    async def start_audio(self):
        if self.stt_task is not None:
            return  # already running
        try:
            await self.connect_stt()
        except Exception as exc:  # noqa: BLE001
            await self._send_stt_status(f"Could not connect to transcription service: {exc}")
            return
        if self.stt_ws is not None:
            self.stt_task = asyncio.create_task(self.listen_stt_forever())

    async def stop_audio(self):
        if self.stt_task is not None:
            self.stt_task.cancel()
            self.stt_task = None
        if self.stt_ws is not None:
            await self.stt_ws.close()
            self.stt_ws = None

    # ---------------- STT: connect ----------------

    async def connect_stt(self):
        if STT_PROVIDER == "deepgram":
            await self._connect_deepgram()
        elif STT_PROVIDER == "openai":
            await self._connect_openai_realtime()
        else:
            await self._send_error(f"Unknown STT_PROVIDER '{STT_PROVIDER}'")

    async def _connect_deepgram(self):
        if not DEEPGRAM_API_KEY:
            await self._send_error("DEEPGRAM_API_KEY is not set on the backend.")
            return
        self.stt_ws = await websockets.connect(
            DEEPGRAM_URL,
            additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
            open_timeout=15,
        )

    async def _connect_openai_realtime(self):
        if not OPENAI_API_KEY:
            await self._send_error("OPENAI_API_KEY is not set on the backend.")
            return
        self.stt_ws = await websockets.connect(
            OPENAI_REALTIME_URL,
            additional_headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            open_timeout=20,
        )
        await self.stt_ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "transcription": {"model": "gpt-4o-transcribe"},
                        "turn_detection": None,
                    }
                },
            },
        }))

    # ---------------- STT: audio in ----------------

    async def pump_audio(self, chunk: bytes):
        if self.stt_ws is None:
            return
        try:
            if STT_PROVIDER == "openai":
                import base64
                await self.stt_ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(chunk).decode("ascii"),
                }))
            else:
                await self.stt_ws.send(chunk)
        except websockets.exceptions.ConnectionClosed:
            pass

    async def commit_audio(self):
        if self.stt_ws is not None and STT_PROVIDER == "openai":
            try:
                await self.stt_ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            except websockets.exceptions.ConnectionClosed:
                pass

    # ---------------- STT: transcripts out ----------------

    async def listen_stt_forever(self):
        MAX_RETRIES = 5
        retry_delay = 1.0
        attempt = 0
        while True:
            try:
                if STT_PROVIDER == "deepgram":
                    await self._listen_deepgram()
                elif STT_PROVIDER == "openai":
                    await self._listen_openai_realtime()
                return
            except (websockets.exceptions.ConnectionClosed, ConnectionError) as exc:
                attempt += 1
                print(f"[stt] connection dropped ({exc}); reconnect attempt {attempt}/{MAX_RETRIES}...")
                if attempt >= MAX_RETRIES:
                    await self._send_stt_status(
                        "Transcription stopped reconnecting after repeated failures "
                        "(likely no audio is reaching it). Click Start again to retry."
                    )
                    return
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 15)
                try:
                    await self.connect_stt()
                except Exception as reconnect_exc:  # noqa: BLE001
                    await self._send_stt_status(f"STT reconnect failed: {reconnect_exc}")
                    return

    async def _listen_deepgram(self):
        """Accumulates every finalized utterance into self.last_transcript so a
        lengthy, multi-sentence question isn't reduced to just its last sentence.
        Only resets when the user actually asks for an answer (or hits Clear)."""
        assert self.stt_ws is not None
        async for raw in self.stt_ws:
            data = json.loads(raw)
            alt = data.get("channel", {}).get("alternatives", [{}])[0]
            text = alt.get("transcript", "")
            if not text:
                continue

            if data.get("is_final"):
                # This chunk of speech is finalized — permanently append it.
                self.last_transcript = (self.last_transcript + " " + text).strip()
                self._partial_transcript = ""
            else:
                # Still-being-refined interim text — don't commit it yet, just
                # preview it live on top of what's already accumulated.
                self._partial_transcript = text

            full_preview = (self.last_transcript + " " + self._partial_transcript).strip()
            await self.client_ws.send_text(json.dumps({"type": "transcript", "text": full_preview}))
            # NOTE: no auto-answer here on purpose — the user explicitly triggers an
            # answer (Enter / Get Answer button) so a new question being transcribed
            # while they're still reading the current answer doesn't wipe it out.

    async def _listen_openai_realtime(self):
        """Same accumulation behavior as Deepgram above, adapted to OpenAI's
        delta/completed event pair per turn."""
        assert self.stt_ws is not None
        self._partial_transcript = ""
        async for raw in self.stt_ws:
            data = json.loads(raw)
            event_type = data.get("type", "")

            if event_type == "conversation.item.input_audio_transcription.delta":
                self._partial_transcript += data.get("delta", "")
                full_preview = (self.last_transcript + " " + self._partial_transcript).strip()
                await self.client_ws.send_text(json.dumps({"type": "transcript", "text": full_preview}))
            elif event_type == "conversation.item.input_audio_transcription.completed":
                final_text = data.get("transcript", self._partial_transcript)
                self.last_transcript = (self.last_transcript + " " + final_text).strip()
                self._partial_transcript = ""
                await self.client_ws.send_text(json.dumps({"type": "transcript", "text": self.last_transcript}))
                # No auto-answer here either — same reasoning as Deepgram above.
            elif event_type == "error":
                await self._send_stt_status(f"OpenAI realtime error: {data.get('error', data)}")

    # ---------------- LLM: text answers (with conversation history) ----------------

    async def generate_answer(self, question: str):
        if not question.strip():
            return
        if LLM_PROVIDER == "anthropic":
            await self._generate_answer_anthropic(question)
        elif LLM_PROVIDER == "openai":
            await self._generate_answer_openai(question)
        elif LLM_PROVIDER == "gemini":
            await self._generate_answer_gemini(question)
        elif LLM_PROVIDER == "ollama":
            await self._generate_answer_ollama(question)
        elif LLM_PROVIDER == "groq":
            await self._generate_answer_groq(question)
        else:
            await self._send_error(f"Unknown LLM_PROVIDER '{LLM_PROVIDER}'")

    async def _generate_answer_anthropic(self, question: str):
        if anthropic_client is None:
            await self._send_error("ANTHROPIC_API_KEY is not set on the backend.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            messages = list(self.history) + [{"role": "user", "content": question}]
            async with anthropic_client.messages.stream(
                model="claude-sonnet-4-6",
                max_tokens=600,
                system=self.system_prompt,
                messages=messages,
            ) as stream:
                async for text_chunk in stream.text_stream:
                    full_answer += text_chunk
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": text_chunk,
                    }))
            self.add_to_history("user", question)
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"LLM error: {exc}")

    async def _generate_answer_openai(self, question: str):
        if openai_client is None:
            await self._send_error("OPENAI_API_KEY is not set on the backend.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            messages = (
                [{"role": "system", "content": self.system_prompt}]
                + list(self.history)
                + [{"role": "user", "content": question}]
            )
            stream = await openai_client.chat.completions.create(
                model="gpt-4o",
                max_tokens=600,
                stream=True,
                messages=messages,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    full_answer += delta
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": delta,
                    }))
            self.add_to_history("user", question)
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"LLM error: {exc}")

    async def _generate_answer_gemini(self, question: str):
        if gemini_client is None:
            await self._send_error("GEMINI_API_KEY is not set on the backend.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            from google.genai import types

            contents = []
            for turn in self.history:
                role = "model" if turn["role"] == "assistant" else "user"
                contents.append(types.Content(role=role, parts=[types.Part.from_text(text=turn["content"])]))
            contents.append(types.Content(role="user", parts=[types.Part.from_text(text=question)]))

            stream = await gemini_client.aio.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=self.system_prompt,
                    max_output_tokens=600,
                ),
            )
            async for chunk in stream:
                if chunk.text:
                    full_answer += chunk.text
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": chunk.text,
                    }))
            self.add_to_history("user", question)
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"LLM error: {exc}")

    async def _generate_answer_ollama(self, question: str):
        if ollama_client is None:
            await self._send_error("Ollama client not initialized.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            messages = (
                [{"role": "system", "content": self.system_prompt}]
                + list(self.history)
                + [{"role": "user", "content": question}]
            )
            stream = await ollama_client.chat(
                model=OLLAMA_TEXT_MODEL,
                messages=messages,
                stream=True,
            )
            async for chunk in stream:
                text = chunk.get("message", {}).get("content", "")
                if text:
                    full_answer += text
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": text,
                    }))
            self.add_to_history("user", question)
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(
                f"Ollama error: {exc} — is Ollama running? Check with 'ollama list' in Terminal."
            )

    async def _generate_answer_groq(self, question: str):
        if groq_client is None:
            await self._send_error("GROQ_API_KEY is not set on the backend.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            messages = (
                [{"role": "system", "content": self.system_prompt}]
                + list(self.history)
                + [{"role": "user", "content": question}]
            )
            stream = await groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                max_tokens=600,
                stream=True,
                messages=messages,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    full_answer += delta
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": delta,
                    }))
            self.add_to_history("user", question)
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"Groq error: {exc}")

    # ---------------- LLM: screenshot / vision answers ----------------

    async def answer_from_screenshot(self, base64_png: str):
        if not base64_png:
            await self._send_error("No screenshot data received.")
            return
        await self._answer_from_images([base64_png])

    async def answer_from_screenshot_sequence(self, base64_pngs: list):
        if not base64_pngs:
            await self._send_error("No screenshots received.")
            return
        await self._answer_from_images(base64_pngs)

    async def _answer_from_images(self, base64_pngs: list):
        if LLM_PROVIDER == "gemini":
            await self._answer_from_images_gemini(base64_pngs)
        elif LLM_PROVIDER == "groq":
            await self._answer_from_images_groq(base64_pngs)
        elif LLM_PROVIDER == "ollama":
            await self._answer_from_images_ollama(base64_pngs)
        else:
            await self._send_error(
                f"Screenshot solving isn't wired up for LLM_PROVIDER='{LLM_PROVIDER}' "
                "— use gemini, groq, or ollama for this feature."
            )

    async def _answer_from_images_gemini(self, base64_pngs: list):
        if gemini_client is None:
            await self._send_error("GEMINI_API_KEY is not set on the backend.")
            return
        n = len(base64_pngs)
        await self.client_ws.send_text(json.dumps({
            "type": "transcript", "text": f"[{n} screenshot(s) captured — reading and analyzing...]",
        }))
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            import base64
            from google.genai import types

            contents = []
            for turn in self.history:
                role = "model" if turn["role"] == "assistant" else "user"
                contents.append(types.Content(role=role, parts=[types.Part.from_text(text=turn["content"])]))

            image_parts = [
                types.Part.from_bytes(data=base64.b64decode(png), mime_type="image/jpeg")
                for png in base64_pngs
            ]
            contents.append(types.Content(
                role="user",
                parts=[types.Part.from_text(text=screenshot_prompt(n)), *image_parts],
            ))

            stream = await gemini_client.aio.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=self.system_prompt,
                    max_output_tokens=1500,
                ),
            )
            async for chunk in stream:
                if chunk.text:
                    full_answer += chunk.text
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": chunk.text,
                    }))
            self.add_to_history("user", f"[Shared {n} screenshot(s) of a problem]")
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"Screenshot analysis error: {exc}")

    async def _answer_from_images_groq(self, base64_pngs: list):
        if groq_client is None:
            await self._send_error("GROQ_API_KEY is not set on the backend.")
            return
        n = len(base64_pngs)
        await self.client_ws.send_text(json.dumps({
            "type": "transcript", "text": f"[{n} screenshot(s) captured — reading and analyzing...]",
        }))
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            content = [{"type": "text", "text": screenshot_prompt(n)}]
            for png in base64_pngs:
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{png}"},
                })
            messages = (
                [{"role": "system", "content": self.system_prompt}]
                + list(self.history)
                + [{"role": "user", "content": content}]
            )
            stream = await groq_client.chat.completions.create(
                model="qwen/qwen3.6-27b",
                max_tokens=1500,
                stream=True,
                messages=messages,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    full_answer += delta
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": delta,
                    }))
            self.add_to_history("user", f"[Shared {n} screenshot(s) of a problem]")
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"Groq vision error: {exc}")

    async def _answer_from_images_ollama(self, base64_pngs: list):
        if ollama_client is None:
            await self._send_error("Ollama client not initialized.")
            return
        n = len(base64_pngs)
        await self.client_ws.send_text(json.dumps({
            "type": "transcript",
            "text": f"[{n} screenshot(s) captured — reading and analyzing with local model...]",
        }))
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        full_answer = ""
        try:
            messages = (
                [{"role": "system", "content": self.system_prompt}]
                + list(self.history)
                + [{"role": "user", "content": screenshot_prompt(n), "images": base64_pngs}]
            )
            stream = await ollama_client.chat(
                model=OLLAMA_VISION_MODEL,
                messages=messages,
                stream=True,
            )
            async for chunk in stream:
                text = chunk.get("message", {}).get("content", "")
                if text:
                    full_answer += text
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": text,
                    }))
            self.add_to_history("user", f"[Shared {n} screenshot(s) of a problem]")
            self.add_to_history("assistant", full_answer)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(
                f"Ollama vision error: {exc} — make sure you've run "
                f"'ollama pull {OLLAMA_VISION_MODEL}' and Ollama is running."
            )

    # ---------------- misc ----------------

    async def _send_error(self, message: str):
        try:
            await self.client_ws.send_text(json.dumps({"type": "error", "message": message}))
        except Exception:  # noqa: BLE001
            pass

    async def _send_stt_status(self, message: str):
        try:
            await self.client_ws.send_text(json.dumps({"type": "stt_status", "message": message}))
        except Exception:  # noqa: BLE001
            pass

    async def close(self):
        await self.stop_audio()


@app.websocket("/ws/session")
async def session_endpoint(websocket: WebSocket):
    await websocket.accept()
    session = Session(websocket)
    # Note: audio/transcription is NOT started here anymore — the connection is ready
    # immediately for typed questions and screenshots. Audio only starts when the
    # client sends 'start_audio' (i.e. when the user clicks Start).

    try:
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"] is not None:
                await session.pump_audio(message["bytes"])

            elif "text" in message and message["text"] is not None:
                payload = json.loads(message["text"])
                msg_type = payload.get("type")

                if msg_type == "context":
                    session.resume = payload.get("resume", "")
                    session.jd = payload.get("jd", "")
                    session.extra_knowledge = payload.get("extra_knowledge", "")
                    session.answer_length = payload.get("answer_length", "concise")
                    session.answer_tone = payload.get("answer_tone", "professional")
                    session.custom_instructions = payload.get("custom_instructions", "")
                    session.experience_level = payload.get("experience_level", "")
                    session.target_role = payload.get("target_role", "")
                    session.rebuild_system_prompt()
                elif msg_type == "start_audio":
                    await session.start_audio()
                elif msg_type == "stop_audio":
                    await session.stop_audio()
                elif msg_type == "manual_trigger":
                    if session.last_transcript:
                        question = session.last_transcript
                        session.last_transcript = ""  # fresh accumulation starts for the next question
                        session._partial_transcript = ""
                        await session.generate_answer(question)
                elif msg_type == "commit":
                    await session.commit_audio()
                elif msg_type == "screenshot":
                    await session.answer_from_screenshot(payload.get("image", ""))
                elif msg_type == "screenshot_sequence":
                    await session.answer_from_screenshot_sequence(payload.get("images", []))
                elif msg_type == "manual_text_question":
                    text = payload.get("text", "").strip()
                    if text:
                        session.last_transcript = text
                        await session.generate_answer(text)
                elif msg_type == "clear":
                    session.clear_history()

    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        await session.close()


@app.post("/extract-pdf")
async def extract_pdf(file: UploadFile = File(...)):
    """Extracts plain text from an uploaded PDF resume so it can be pasted straight
    into the resume field without the user copy-pasting manually."""
    try:
        import pypdf
        content = await file.read()
        reader = pypdf.PdfReader(io.BytesIO(content))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        if not text.strip():
            return {"error": "No extractable text found — the PDF might be a scanned image."}
        return {"text": text}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "stt_provider": STT_PROVIDER,
        "llm_provider": LLM_PROVIDER,
        "deepgram_configured": bool(DEEPGRAM_API_KEY),
        "anthropic_configured": bool(ANTHROPIC_API_KEY),
        "openai_configured": bool(OPENAI_API_KEY),
        "gemini_configured": bool(GEMINI_API_KEY),
        "groq_configured": groq_client is not None,
        "ollama_configured": ollama_client is not None,
    }


if __name__ == "__main__":
    # Lets this file run standalone — either directly with 'python main.py', or as
    # the entry point when frozen into a PyInstaller executable (that's what
    # actually gets bundled into the packaged app so end users don't need Python
    # installed). --ws-max-size mirrors the CLI flag used in dev mode.
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, ws_max_size=20_000_000)
