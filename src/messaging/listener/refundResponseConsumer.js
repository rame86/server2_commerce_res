// src/messaging/listener/refundResponseConsumer.js

const prisma = require('../../config/prisma');
const { QUEUES, EXCHANGE, ROUTING_KEYS, getConnection } = require('../../config/rabbitMQ');

/**
 * [관리자 환불 응답 리스너]
 * 관리자 서비스(Admin Service)에서 결정된 환불 승인/반려 결과를 수신하여 후속 조치를 수행함.
 * 승인(CONFIRMED) 시 결제 서버로 취소 요청을 전달하고, 반려 시 예약 상태를 원복함.
 */
async function startRefundResponseConsumer() {
    try {
        // RabbitMQ 커넥션 객체 확인
        const connection = getConnection();
        if (!connection) {
            console.error("❌ RabbitMQ 연결 실패: RefundResponseConsumer를 시작할 수 없음");
            return;
        }

        // 메시지 채널 생성
        const channel = await connection.createChannel();

        // 1. 관리자가 답장을 보내줄 전용 큐(refund.res.core.queue) 생성 및 설정
        // durable: true -> 메시지 브로커 재시작 시에도 큐 데이터 유지
        await channel.assertQueue(QUEUES.REFUND_RES_CORE, { durable: true });
        
        // 정의된 익스체인지와 라우팅 키를 큐에 바인딩하여 메시지 수신 경로 설정
        await channel.bindQueue(QUEUES.REFUND_RES_CORE, EXCHANGE, ROUTING_KEYS.REFUND_RES_CORE);

        console.log(`👷 [Refund Response Consumer] 구독 중: ${QUEUES.REFUND_RES_CORE}`);

        // 메시지 소비(Consume) 시작
        channel.consume(QUEUES.REFUND_RES_CORE, async (msg) => {
            if (!msg) return;

            // 수신된 메시지 본문을 JSON 객체로 변환
            const response = JSON.parse(msg.content.toString());
            console.log("📥 [Admin Refund Response 수신]:", response);

            /**
             * [데이터 추출 및 매핑]
             * 관리자 시스템의 데이터 규격에 맞게 티켓 코드, 상태, 반려 사유를 정규화함.
             */
            const ticketCode = response.targetId || response.ticket_code;
            
            // APPROVED 또는 CONFIRMED 상태인 경우 모두 내부적으로 'CONFIRMED'로 취급
            const status = (response.status === 'APPROVED' || response.status === 'CONFIRMED') 
                ? 'CONFIRMED' : response.status;
            
            // 반려 사유 필드(reason 또는 rejectionReason) 추출
            const rejectionReason = response.reason || response.rejectionReason || null;

            try {
                // 필수 식별자인 티켓 코드가 없을 경우 예외 발생
                if (!ticketCode) {
                    throw new Error("관리자 응답에 ticketCode(targetId)가 누락되었습니다.");
                }

                /**
                 * [환불 기록 조회]
                 * 현재 PENDING(대기) 상태이면서 해당 티켓 코드를 가진 환불 요청 레코드를 검색함.
                 * include를 통해 연관된 예약(reservations) 테이블 정보를 함께 가져옴.
                 */
                const refundRecord = await prisma.reservation_refunds.findFirst({
                    where: {
                        status: 'PENDING',
                        reservations: {
                            ticket_code: ticketCode
                        }
                    },
                    include: { reservations: true }
                });

                // 환불 기록이 존재하지 않을 경우 에러 처리
                if (!refundRecord) throw new Error(`티켓 코드 ${ticketCode}에 해당하는 환불 기록을 찾을 수 없음`);

                // 실제 환불 레코드의 기본키(ID) 저장
                const realRefundId = refundRecord.refund_id;

                if (status === 'CONFIRMED') {
                    /**
                     * [환불 승인 로직]
                     * 1. DB 환불 상태를 'APPROVED'로 업데이트
                     * 2. 결제 서버(Payment Service)로 실제 결제 취소 요청 발행
                     */
                    await prisma.$transaction(async (tx) => {
                        await tx.reservation_refunds.update({
                            where: { refund_id: realRefundId },
                            data: { status: 'APPROVED', processed_at: new Date() }
                        });
            
                        // 결제 시스템 전달용 데이터 객체 생성
                        const paymentCancelData = {
                            orderId: refundRecord.reservations.ticket_code,
                            memberId: Number(refundRecord.member_id),
                            amount: Number(refundRecord.refund_amount),
                            type: "REFUND",
                            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE // 결제 처리 후 결과를 돌려받을 라우팅 키
                        };

                        // 결제 요청 큐(PAY_REQUEST)로 메시지 발행 (Message Relay)
                        channel.publish(
                            EXCHANGE,
                            ROUTING_KEYS.PAY_REQUEST,
                            Buffer.from(JSON.stringify(paymentCancelData)),
                            { persistent: true, contentType: 'application/json' }
                        );
                    });
                   console.log(`🚀 [Payment Relay] RefundID ${realRefundId} 승인 -> 결제 취소 큐 발송 완료`);

                } else if (status === 'REJECTED' || status === 'FAILED') {
                    /**
                     * [환불 반려 로직]
                     * 1. DB 환불 상태를 'REJECTED'로 업데이트하고 사유 저장
                     * 2. 예약 상태를 'REFUND_REJECTED'로 변경하여 티켓을 다시 사용 가능한 상태로 복구
                     */
                    await prisma.$transaction(async (tx) => {
                        await tx.reservation_refunds.update({
                            where: { refund_id: realRefundId },
                            data: { status: 'REJECTED', rejection_reason: rejectionReason, processed_at: new Date() }
                        });

                        await tx.reservations.update({
                            where: { reservation_id: refundRecord.reservation_id },
                            data: { status: 'REFUND_REJECTED' }
                        });
                    });
                    console.log(`🚀 [Refund Rejected] RefundID ${realRefundId} 반려 처리 및 예약 상태 원복 완료`);
                }

                // 성공적으로 로직 처리 완료 시 브로커에 확인 응답(Ack) 전송
                channel.ack(msg);

            } catch (err) {
                console.error("❌ 환불 응답 처리 중 내부 에러:", err.message);
                // 에러 발생 시 메시지를 다시 큐에 넣지 않고 폐기(nack)
                // 필요 시 Dead Letter Exchange 설정을 통해 사후 분석 가능
                channel.nack(msg, false, false); 
            }
        });

    } catch (err) {
        // 컨슈머 초기화 및 채널 설정 단계에서 발생한 에러 처리
        console.error("❌ Refund Response Consumer 초기화 에러:", err);
    }
}

module.exports = startRefundResponseConsumer;