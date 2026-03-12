// src/messaging/listener/cancelConsumer.js

// 데이터베이스(Prisma)와 캐시(Redis), 그리고 RabbitMQ 설정을 가져옴
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');
const { QUEUES, getConnection } = require('../../config/rabbitMQ');

/**
 * [비상 취소 감시 컨슈머 시작]
 * 외부(결제 서비스 등)에서 날아온 취소 이벤트를 듣고 DB와 Redis의 재고를 원복함
 */
async function startCancelConsumer() {
    try {
        // 1. [커넥션 재사용] rabbitMQ.js에서 만든 물리적 연결을 그대로 가져옴
        const connection = getConnection();
        if (!connection) throw new Error("RabbitMQ 연결이 안 되어 있어.");

        // 2. [채널 생성] 물리적 연결 하나 안에서 이 컨슈머 전용의 논리적 통로(Channel)를 개설
        const channel = await connection.createChannel();

        // 3. [큐 확인] 사용할 취소 전용 큐가 있는지 확인 (durable: true로 메시지 안전 보장)
        await channel.assertQueue(QUEUES.CANCEL, { durable: true });
        // 감시 시작 알림 로그 출력
        console.log(`🛡️ [Cancel Consumer] 비상 취소 감시 중: ${QUEUES.CANCEL}`);

        /**
         * [메시지 소비 시작]
         * 취소 큐에 메시지가 들어오면 아래 콜백 함수가 실행됨
         */
        channel.consume(QUEUES.CANCEL, async (msg) => {
            // 전달된 메시지가 비어있으면 로직 수행 안 함
            if (!msg) return;

            // 큐에서 받은 바이너리 데이터를 JSON 객체로 변환 (주문번호와 사유 확보)
            const { orderId, reason } = JSON.parse(msg.content.toString());
            console.log(`⚠️ [취소 감지] 주문번호: ${orderId}, 사유: ${reason}`);

            try {
                // 4. [데이터 조회] 취소 요청이 들어온 주문번호가 우리 DB에 실제로 있는지 확인
                const reservation = await prisma.reservations.findUnique({
                    where: { ticket_code: orderId }
                });

                // 5. [중복 처리 방지] 예약이 존재하고, 이미 실패(FAILED) 처리된 건이 아닐 때만 복구 진행
                if (reservation && reservation.status !== 'FAILED') {
                    
                    /**
                     * [DB 보상 트랜잭션 실행]
                     * 예약 상태 변경과 재고 수량 복구는 반드시 동시에 성공해야 하므로 트랜잭션으로 묶음
                     */
                    await prisma.$transaction(async (tx) => {
                        // (1) 해당 예약 건의 상태를 'FAILED'로 업데이트
                        await tx.reservations.update({
                            where: { ticket_code: orderId },
                            data: { status: 'FAILED' }
                        });
                        // (2) 해당 공연 테이블의 가용 좌석 수(available_seats)를 취소 수량만큼 증가(+)
                        await tx.events.update({
                            where: { event_id: reservation.event_id },
                            data: { available_seats: { increment: reservation.ticket_count } }
                        });
                    });

                    // 6. [Redis 재고 원복] 실시간 선착순 엔진인 Redis의 재고 수량도 즉시 복구
                    const stockKey = `event:stock:${reservation.event_id}`;
                    await redis.incrBy(stockKey, reservation.ticket_count);
                    // 복구 완료 로그 출력
                    console.log(`⏪ [롤백 완료] 주문 ${orderId} 취소 및 재고 복구 성공`);
                }
                
                // 7. [수신 확인] 처리가 끝났으므로 RabbitMQ에 메시지 삭제를 요청(Ack)
                channel.ack(msg);
            } catch (error) {
                // 내부 로직 실패 시 로그를 남기고 메시지는 폐기하여 무한 재시도 현상 방지
                console.error("❌ 취소 처리 중 오류:", error.message);
                // 메시지 재입고(requeue)를 하지 않도록 nack 처리
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        // 커넥션이나 채널 생성 자체에 실패했을 때 에러 출력
        console.error("❌ CancelConsumer 에러:", error.message);
    }
}
// 외부에서 이 함수를 실행할 수 있도록 내보냄
module.exports = startCancelConsumer;