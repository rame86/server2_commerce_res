// src/messaging/listener/refundResponseConsumer.js
const { QUEUES, EXCHANGE, ROUTING_KEYS, getConnection } = require('../../config/rabbitMQ');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * [관리자 환불 응답 리스너]
 * 관리자가 환불을 승인(CONFIRMED)하면 실제 결제 서버로 취소 큐를 토스함
 */
async function startRefundResponseConsumer() {
    try {
        const connection = getConnection();
        if (!connection) {
            console.error("❌ RabbitMQ 연결 실패: RefundResponseConsumer를 시작할 수 없음");
            return;
        }

        const channel = await connection.createChannel();

        // 1. 관리자가 답장을 보내줄 큐(Java: refund.res.core.queue) 감시
        await channel.assertQueue(QUEUES.REFUND_RES_CORE, { durable: true });
        await channel.bindQueue(QUEUES.REFUND_RES_CORE, EXCHANGE, ROUTING_KEYS.REFUND_RES_CORE);

        console.log(`👷 [Refund Response Consumer] 구독 중: ${QUEUES.REFUND_RES_CORE}`);

        // ... (상단 생략)

        channel.consume(QUEUES.REFUND_RES_CORE, async (msg) => {
            if (!msg) return;

            // ... 컨슈머 내부
            const response = JSON.parse(msg.content.toString());
            console.log("📥 [Admin Refund Response 수신]:", response);

            // 관리자가 targetId에 티켓 코드를 실어 보낸 상황
            const ticketCode = response.targetId || response.ticket_code;
            const status = (response.status === 'REFUND_SUCCESS' || response.status === 'CONFIRMED') ? 'CONFIRMED' : response.status;

            try {
                if (!ticketCode) {
                    throw new Error("관리자 응답에 ticketCode(targetId)가 누락되었습니다.");
                }

                // 💡 수정 핵심: refund_id 대신 연결된 reservations의 ticket_code로 찾기
                const refundRecord = await prisma.reservation_refunds.findFirst({
                    where: {
                        reservations: {
                            ticket_code: ticketCode
                        }
                    },
                    include: { reservations: true }
                });

                if (!refundRecord) throw new Error(`티켓 코드 ${ticketCode}에 해당하는 환불 기록을 찾을 수 없음`);

                // 이후 업데이트 로직에서 PK 사용
                const realRefundId = refundRecord.refund_id;

                if (status === 'CONFIRMED') {
                    await prisma.$transaction(async (tx) => {
                        await tx.reservation_refunds.update({
                            where: { refund_id: realRefundId },
                            data: { status: 'APPROVED', processed_at: new Date() }
                        });
            
                        const paymentCancelData = {
                            orderId: refundRecord.reservations.ticket_code,
                            memberId: Number(refundRecord.member_id),
                            amount: Number(refundRecord.refund_amount),
                            type: "REFUND",
                            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
                        };

                        channel.publish(
                            EXCHANGE,
                            ROUTING_KEYS.PAY_REQUEST,
                            Buffer.from(JSON.stringify(paymentCancelData)),
                            { persistent: true, contentType: 'application/json' }
                        );
                    });
                    console.log(`🚀 [Payment Relay] RefundID ${refundId} 승인 -> 결제 취소 큐 발송 완료`);

                } else if (status === 'REJECTED' || status === 'FAILED') {
                    // ❌ [거절 시] 반려 처리 및 예매 상태 원복
                    await prisma.$transaction(async (tx) => {
                        await tx.reservation_refunds.update({
                            where: { refund_id: Number(refundId) },
                            data: { status: 'REJECTED', rejection_reason: rejectionReason, processed_at: new Date() }
                        });

                        // 예매 상태를 다시 CONFIRMED로 돌려서 티켓을 쓸 수 있게 함
                        await tx.reservations.update({
                            where: { reservation_id: refundRecord.reservation_id },
                            data: { status: 'CONFIRMED' }
                        });
                    });
                    console.log(`🚫 [Refund Rejected] RefundID ${realRefundId} 거절 및 티켓 원복 완료`);
                }

                channel.ack(msg); // 메시지 처리 완료

            } catch (err) {
                console.error("❌ 환불 응답 처리 중 내부 에러:", err.message);
                // 에러 발생 시 큐에서 지우지 않고 재시도하지 않음 (nack)
                channel.nack(msg, false, false); 
            }
        });

    } catch (err) {
        console.error("❌ Refund Response Consumer 초기화 에러:", err);
    }
}

module.exports = startRefundResponseConsumer;