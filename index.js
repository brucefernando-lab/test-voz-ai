import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
const SYSTEM_MESSAGE = 'Eres Sofía. Responde de forma muy breve. Si el usuario te interrumpe, deja de hablar inmediatamente.';
const VOICE_MODEL = 'gpt-4o-mini-realtime-preview';

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Sofía está en línea');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (connection, req) => {
    console.log('✅ Intento de conexión recibido');

    let streamSid = "";
    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${VOICE_MODEL}`, {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    openAiWs.on('open', () => {
        console.log('📡 Conectado a OpenAI');
        openAiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: SYSTEM_MESSAGE,
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                turn_detection: { type: 'server_vad' }
            }
        }));
    });

    openAiWs.on('message', (data) => {
        const response = JSON.parse(data);

        // --- INTERRUPCIÓN (Barge-in) ---
        if (response.type === 'input_audio_buffer.speech_started') {
            console.log('🎤 Usuario hablando... Callando a Sofía');
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            if (streamSid) {
                connection.send(JSON.stringify({ event: 'clear', streamSid }));
            }
        }

        if (response.type === 'response.audio.delta' && response.delta) {
            connection.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: response.delta }
            }));
        }
    });

    connection.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log('📞 Llamada iniciada, StreamSid:', streamSid);
        } else if (msg.event === 'media') {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: msg.media.payload
                }));
            }
        }
    });

    connection.on('close', () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        console.log('❌ Twilio desconectado');
    });

    openAiWs.on('error', (err) => console.log('OAI Error:', err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Sofía lista en puerto ${PORT}`);
});
