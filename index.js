import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const { OPENAI_API_KEY, N8N_WEBHOOK_URL, N8N_TRACKING_WEBHOOK_URL } = process.env;
const SYSTEM_MESSAGE = 'Eres Sofía. Responde breve. PUEDES SER INTERRUMPIDA. Si te dan un número de guía, usa la herramienta "consultar_guia". Al final de la llamada envía un reporte.';
const VOICE_MODEL = 'gpt-4o-mini-realtime-preview';

// Definición de la herramienta de rastreo
const TOOLS = [{
    type: "function",
    name: "consultar_guia",
    description: "Consulta el estatus de un paquete en n8n",
    parameters: {
        type: "object",
        properties: { numero_guia: { type: "string" } },
        required: ["numero_guia"]
    }
}];

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Sofía está en línea y lista');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (connection, req) => {
    console.log('✅ Cliente conectado');

    let streamSid = "";
    let callSid = "";
    let startTime = Date.now();

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
                tools: TOOLS,
                tool_choice: "auto",
                turn_detection: { type: 'server_vad', threshold: 0.5 }
            }
        }));
    });

    openAiWs.on('message', async (data) => {
        const response = JSON.parse(data);

        // --- INTERRUPCIÓN ---
        if (response.type === 'input_audio_buffer.speech_started') {
            console.log('🎤 Usuario hablando...');
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            if (streamSid) connection.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        // --- RASTREO DE PAQUETES (TOOLS) ---
        if (response.type === 'response.done' && response.response?.output) {
            for (const output of response.response.output) {
                if (output.type === 'function_call' && output.name === 'consultar_guia') {
                    const { numero_guia } = JSON.parse(output.arguments);
                    console.log(`🔍 Consultando n8n por guía: ${numero_guia}`);
                    
                    try {
                        const n8nRes = await fetch(N8N_TRACKING_WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ numero_guia, callSid })
                        });
                        const info = await n8nRes.json();
                        
                        openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: { type: 'function_call_output', call_id: output.call_id, output: JSON.stringify(info) }
                        }));
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                    } catch (e) { console.error("Error n8n:", e.message); }
                }
            }
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
            console.log('📞 Llamada:', callSid);
        } else if (msg.event === 'media') {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
            }
        }
    });

    connection.on('close', async () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        console.log('❌ Fin de llamada');
        
        const duration = Math.floor((Date.now() - startTime) / 1000);
        if (N8N_WEBHOOK_URL) {
            fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'call_ended', duration, callSid, summary: "Llamada procesada" })
            }).catch(() => {});
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Sofía lista en puerto ${PORT}`));
