import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const { OPENAI_API_KEY, N8N_WEBHOOK_URL, N8N_TRACKING_WEBHOOK_URL } = process.env;
const SYSTEM_MESSAGE = 'Eres Sofía. Responde corto. PUEDES SER INTERRUMPIDA: si el usuario habla, cállate inmediatamente.';
const VOICE_MODEL = 'gpt-4o-mini-realtime-preview';

// Crear servidor básico
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Sofía está viva');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (connection, req) => {
    if (req.url !== '/media-stream') return connection.close();
    console.log('✅ Twilio conectado');

    let streamSid = "";
    let callSid = "";
    let startTime = Date.now();

    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${VOICE_MODEL}`, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

    openAiWs.on('open', () => {
        console.log('📡 Conectado a OpenAI');
        openAiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: SYSTEM_MESSAGE,
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                turn_detection: { type: 'server_vad', threshold: 0.5 }
            }
        }));
    });

    openAiWs.on('message', async (data) => {
        const response = JSON.parse(data);

        // --- INTERRUPCIÓN (Si hablas, la IA se calla) ---
        if (response.type === 'input_audio_buffer.speech_started') {
            console.log('🎤 Interrupción detectada');
            openAiWs.send(JSON.stringify({ type: 'response.cancel' })); // Para a OpenAI
            connection.send(JSON.stringify({ event: 'clear', streamSid })); // Limpia el audio en el teléfono
        }

        if (response.type === 'response.audio.delta' && response.delta) {
            connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: response.delta } }));
        }
    });

    connection.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            console.log('📞 Llamada en curso:', callSid);
        } else if (msg.event === 'media') {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
            }
        }
    });

    connection.on('close', async () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        console.log('❌ Llamada terminada');
        
        // Enviar reporte a n8n
        const duration = Math.floor((Date.now() - startTime) / 1000);
        if (N8N_WEBHOOK_URL) {
            fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'call_ended', duration, callSid })
            }).catch(() => {});
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Sofía lista en puerto ${PORT}`));
