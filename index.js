import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

// CAMBIO CRÍTICO: Usamos el modelo "mini", que es mucho más económico
const VOICE_MODEL = "gpt-4o-mini-realtime-preview";

const { OPENAI_API_KEY, N8N_WEBHOOK_URL, N8N_TRACKING_WEBHOOK_URL } = process.env;

const SYSTEM_MESSAGE = `Eres Sofía, Consultora Senior de YouthNex. 
REGLAS DE ORO PARA AHORRO DE COSTOS:
1. Sé EXTREMADAMENTE breve. Máximo 2 oraciones por respuesta.
2. No repitas información si no te la piden.
3. Si el usuario calla, no rellenes el silencio.
4. Tono profesional y persuasivo sobre NEX02.

PRODUCTO: NEX02 (Biohacking, energía mitocondrial, $2600 MXN con 4 botes).
NEGOCIO: Micro-franquicias, ingresos residuales.
OBJETIVO: Agendar llamada o enviar enlace.
Al final de la llamada envía un reporte.`;

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
    res.end('Sofía Mini está en línea');
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
        console.log('📡 Conectado a OpenAI (Modelo Mini)');

        openAiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: SYSTEM_MESSAGE,
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                voice: "shimmer",
                temperature: 0.6, // Bajamos un poco la temperatura para que sea más directa
                turn_detection: { type: 'server_vad' },
                tools: TOOLS
            }
        }));

        openAiWs.send(JSON.stringify({
            type: "response.create",
            response: {
                modalities: ["audio", "text"],
                instructions: "Saluda corto: 'Hola, soy Sofía de YouthNex, ¿buscas mejorar tu salud o el negocio?'"
            }
        }));
    });

    openAiWs.on('message', async (data) => {
        const response = JSON.parse(data);

        // Interrupción: Si el usuario habla, cancelamos la respuesta actual para ahorrar audio
        if (response.type === 'input_audio_buffer.speech_started') {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            if (streamSid) connection.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        if (response.type === 'response.done' && response.response?.output) {
            for (const output of response.response.output) {
                if (output.type === 'function_call' && output.name === 'consultar_guia') {
                    const { numero_guia } = JSON.parse(output.arguments);
                    try {
                        const n8nRes = await fetch(N8N_TRACKING_WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ numero_guia, callSid })
                        });
                        const info = await n8nRes.json();
                        openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: output.call_id,
                                output: JSON.stringify(info)
                            }
                        }));
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                    } catch (e) {
                        console.error("Error n8n:", e.message);
                    }
                }
            }
        }

        if (response.type === 'response.audio.delta' && response.delta) {
            connection.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: response.delta }
            }));
        }
    });

    connection.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
        }
        if (msg.event === 'media' && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: msg.media.payload
            }));
        }
    });

    connection.on('close', () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
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
server.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
