'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK - Twilio <-> OpenAI Realtime Bridge\n");
});

server.on('listening', () => {
  console.log(`[BOOT] HTTP server listening on :${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (twilioWs, req) => {
  console.log('[TWILIO] WebSocket connected');

  let streamSid = null;

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openaiWs.on('open', () => {
    console.log('[OPENAI] Connected');

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        instructions: "Eres Sofía, asistente amable y profesional. Responde breve y claro en español.",
        turn_detection: { type: "server_vad" }
      }
    }));
  });

  twilioWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      console.log('[TWILIO] streamSid:', streamSid);
    }

    if (msg.event === 'media' && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }
  });

  openaiWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: streamSid,
        media: { payload: msg.delta }
      }));
    }
  });
});

server.listen(PORT, '0.0.0.0');
