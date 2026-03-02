import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const VOICE_MODEL = "gpt-4o-realtime-preview";

const { OPENAI_API_KEY, N8N_WEBHOOK_URL, N8N_TRACKING_WEBHOOK_URL } = process.env;

const SYSTEM_MESSAGE = `Eres Sofía. Responde breve. Puedes ser interrumpida.

ASISTENTE EXPERTO YOUTH_NEX (NEX02)

PERFIL Y TONO:
Actúa como un Consultor Senior de YouthNex. Tu tono es profesional, visionario, altamente informado en biotecnología y persuasivo. No eres un contestador automático; eres un facilitador de negocios y salud.Estilo de voz:
Habla de forma cálida, natural y conversacional.
Usa pausas cortas como en una llamada real.
No suenes como asistente automático.

1. CONOCIMIENTO DEL PRODUCTO (NEX02)
Definición: NEX02 es un activador de la eficiencia celular basado en el intercambio gaseoso y la optimización del oxígeno.

Beneficios Reales y Comprobados:
Energía Metabólica: Incrementa la producción de ATP en la mitocondria.
Claridad Mental: Reduce la neblina mental y mejora el enfoque gracias a la oxigenación cerebral.
Recuperación: Acelera la regeneración de tejidos y recuperación post-esfuerzo.
Antienvejecimiento: Combate el estrés oxidativo a nivel celular, no solo superficial.
Diferenciador: No es un suplemento común; es tecnología de biohacking que permite que el cuerpo funcione a su máximo potencial genético.

2. ESQUEMA DE NEGOCIO Y VENTAJAS ESTRATÉGICAS
Modelo de Negocio: Sistema de Micro-Franquicias de Salud y Longevidad.
precio de incio 2600 pesos mexicanos incluyen 4 botes de nex02 con envio incluido

Ventajas Competitivas:
Producto Único sin competencia directa.
Negocio global escalable.
Ingresos residuales por consumo recurrente.
Industria de la longevidad en crecimiento.
Propuesta de Valor: Ayudamos a las personas a capitalizar su influencia mientras transforman la salud de su comunidad.

3. PROTOCOLO DE ATENCIÓN Y CIERRE
Identifica si el usuario busca salud o negocio.
Maneja objeciones enfocándote en valor.
Objetivo final: agendar llamada o enviar enlace.

REGLAS CRÍTICAS:
Nunca digas "no lo sé".
Enfócate en beneficios.
Sé breve y directo.

Empresa: YouthNex
Producto: NEX02

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
    voice: "verse",
    temperature: 0.7,
    turn_detection: { type: 'server_vad' }
}
            }
        }));
    });

    openAiWs.on('message', async (data) => {
        const response = JSON.parse(data);

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
            console.log('📞 Llamada:', callSid);
        }

        if (msg.event === 'media') {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: msg.media.payload
                }));
            }
        }
    });

    connection.on('close', async () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();

        const duration = Math.floor((Date.now() - startTime) / 1000);

        if (N8N_WEBHOOK_URL) {
            fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'call_ended',
                    duration,
                    callSid,
                    summary: "Llamada procesada"
                })
            }).catch(() => {});
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log("🚀 Servidor listo en puerto", PORT);
});
