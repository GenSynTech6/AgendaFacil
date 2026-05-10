import { setGlobalOptions } from "firebase-functions";
import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { MercadoPagoConfig, Payment } from 'mercadopago';

// 1. INICIALIZAÇÃO ÚNICA E SEGURA
// Verifica se já existe uma app inicializada para evitar erros de re-inicialização
if (!getApps().length) {
    initializeApp();
}

const db = getFirestore();

// 2. CONFIGURAÇÕES GLOBAIS
setGlobalOptions({ 
    maxInstances: 10, 
    region: "us-central1",
    timeoutSeconds: 60 // Aumenta o tempo de execução da função se necessário
});

// Inicialização do cliente MP fora das funções para reutilização de instância
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || 'SEU_TOKEN_AQUI' 
});

/**
 * WEBHOOK: Recebe notificações do Mercado Pago
 */
export const hookMercadoPago = onRequest({ cors: true }, async (req, res) => {
    // O Mercado Pago envia o ID do pagamento no corpo ou na query
    const paymentId = req.body.data?.id || req.query['data.id'];

    if (req.body.type === "payment" && paymentId) {
        try {
            const payment = new Payment(client);
            const result = await payment.get({ id: paymentId });

            if (result.status === 'approved') {
                const userId = result.metadata?.user_id;

                if (userId) {
                    const expira = new Date();
                    expira.setMonth(expira.getMonth() + 1);

                    // USO DO DB (Firestore) CORRIGIDO
                    await db.collection("perfis").doc(userId).update({
                        statusPagamento: "ativo",
                        expiraEm: expira,
                        ultimoPagamento: FieldValue.serverTimestamp(),
                        idTransacaoMP: result.id
                    });

                    console.log(`✅ Assinatura liberada para o usuário: ${userId}`);
                }
            }
        } catch (error) {
            console.error("Erro ao processar Webhook:", error);
        }
    }

    // O Mercado Pago exige 200 ou 201 sempre
    res.status(200).send("OK");
});

/**
 * CALLABLE: Processa o pagamento vindo do App/Web
 */
export const processarPagamento = onCall({ cors: true }, async (request) => {
    // Verificação de autenticação
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Operador não identificado no sistema.');
    }

    const data = request.data;
    const payment = new Payment(client);
    const valorDoSistema = 19.90;

    // Proteção contra manipulação de valor no front-end
    if (parseFloat(data.amount) !== valorDoSistema) {
        console.error(`Tentativa de bypass de valor detectada: ${request.auth.uid}`);
        throw new HttpsError('invalid-argument', 'Protocolo de valor inconsistente.');
    }

    const body = {
        transaction_amount: valorDoSistema,
        description: data.description || "Plano Profissional - Agenda Fácil",
        payment_method_id: data.payment_method_id,
        installments: parseInt(data.installments) || 1,
        payer: {
            email: data.email,
            identification: {
                type: data.identificationType || "CPF",
                number: data.identificationNumber
            }
        },
        metadata: {
            user_id: request.auth.uid
        }
    };

    // Adiciona o token se não for PIX
    if (data.payment_method_id !== 'pix') {
        body.token = data.token;
        body.issuer_id = data.issuer_id;
    }

    try {
        const result = await payment.create({ body });

        // 1. APROVAÇÃO IMEDIATA (Cartão)
        if (result.status === 'approved') {
            const expira = new Date();
            expira.setMonth(expira.getMonth() + 1);

            await db.collection("perfis").doc(request.auth.uid).update({
                statusPagamento: "ativo",
                planoAtivo: body.description,
                expiraEm: expira,
                ultimoPagamento: FieldValue.serverTimestamp(),
                idTransacaoMP: result.id,
                metodoPagamento: result.payment_method_id
            });

            return { success: true, id: result.id, status: 'approved' };
        }

        // 2. AGUARDANDO PAGAMENTO (PIX)
        if (result.payment_method_id === 'pix' && result.status === 'pending') {
            return {
                success: true,
                status: 'pending',
                id: result.id,
                qr_code: result.point_of_interaction.transaction_data.qr_code_base64,
                copy_paste: result.point_of_interaction.transaction_data.qr_code
            };
        }

        // 3. FALHA NO PROCESSAMENTO
        return {
            success: false,
            status: result.status,
            detail: result.status_detail
        };

    } catch (error) {
        console.error("ERRO CRÍTICO MP:", error);
        return {
            success: false,
            error: "Falha na comunicação com o provedor de pagamentos."
        };
    }
});