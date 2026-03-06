const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');
const { QUEUES } = require('../../config/rabbitMQ');

async function startCancelConsumer() {
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // 핵심 주석: 중앙 설정파일의 점(.) 표기법 큐 이름 사용
        await channel.assertQueue(QUEUES.CANCEL, { durable: true });

        console.log(`🛡️ [Cancel Consumer] 비상 취소 감시 중: ${QUEUES.CANCEL}`);

        channel.consume(QUEUES.CANCEL, async (msg) => {
            if (!msg) return;

            const { orderId, reason } = JSON.parse(msg.content.toString());
            console.log(`⚠️ [취소 감지] 주문번호: ${orderId}, 사유: ${reason}`);

            try {
                // 1. 해당 주문 데이터 찾기
                const reservation = await prisma.reservations.findUnique({
                    where: { ticket_code: orderId }
                });

                // 2. 이미 취소된 건이 아니라면 보상 트랜잭션(롤백) 실행
                if (reservation && reservation.status !== 'FAILED') {
                    await prisma.$transaction(async (tx) => {
                        // DB 상태 변경
                        await tx.reservations.update({
                            where: { ticket_code: orderId },
                            data: { status: 'FAILED' }
                        });
                        // DB 재고 복구
                        await tx.events.update({
                            where: { event_id: reservation.event_id },
                            data: { available_seats: { increment: reservation.ticket_count } }
                        });
                    });

                    // 3. Redis 실시간 재고 복구
                    const stockKey = `event:stock:${reservation.event_id}`;
                    await redis.incrBy(stockKey, reservation.ticket_count);

                    console.log(`⏪ [롤백 완료] 주문 ${orderId} 취소 및 재고 복구 성공`);
                }
                
                channel.ack(msg);
            } catch (error) {
                console.error("❌ 취소 처리 중 오류:", error.message);
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        console.error("❌ CancelConsumer 연결 실패:", error.message);
    }
}

module.exports = startCancelConsumer;