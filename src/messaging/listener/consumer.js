// src/messaging/listener/consumer.js
const { QUEUES, EXCHANGE, ROUTING_KEYS, getConnection } = require('../../config/rabbitMQ');

/**
 * [메인 중계 컨슈머]
 * 역할: 사용자의 '예약 요청'을 감시하고, Java 결제 서버가 이해할 수 있는 규격으로 가공하여 전달함.
 * (환불 로직은 관리자 승인 절차를 위해 refundResponseConsumer.js로 분리됨)
 */
async function startConsumer() {
    try {
        const connection = getConnection();
        if (!connection) throw new Error("RabbitMQ 연결이 안 되어 있어.");

        const channel = await connection.createChannel();

        // 1. [인프라 선언] 예약 및 결제 요청 큐만 관리
        await channel.assertQueue(QUEUES.RESERVATION, { durable: true });
        await channel.assertQueue(QUEUES.PAY_REQUEST, { durable: true });

        // 2. [바인딩 설정]
        await channel.bindQueue(QUEUES.RESERVATION, EXCHANGE, QUEUES.RESERVATION);
        await channel.bindQueue(QUEUES.PAY_REQUEST, EXCHANGE, ROUTING_KEYS.PAY_REQUEST);

        console.log(`👷 [Consumer] 예약 중계 가동 중: ${QUEUES.RESERVATION}`);

        /**
         * [A. 예약 요청 처리 루프]
         * 예약 서비스에서 온 데이터를 Java 결제 서버 규격(DTO)으로 변환하여 토스함
         */
        channel.consume(QUEUES.RESERVATION, async (msg) => {
            if (!msg) return;

            const data = JSON.parse(msg.content.toString());
            
            try {
                // 비즈니스 정책 검증: 1인당 2매 제한
                if (data.ticket_count > 2) {
                    console.error(`⚠️ [Warn] 예매 제한 초과 발견 - 코드: ${data.ticket_code}`);
                    return channel.ack(msg); 
                }

                const quantity = data.ticket_count || 1;
                const totalPrice = data.total_price || 0;
                const bookingFee = data.booking_fee || 0;

                // Java 결제 서버 DTO 매핑
                const paymentData = {
                    orderId: data.ticket_code,
                    memberId: data.member_id,
                    amount: totalPrice,
                    originalAmount: totalPrice - bookingFee,
                    fee: bookingFee,
                    shippingFee: 0,
                    quantity: quantity,
                    type: "PAYMENT",
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE 
                };

                // 결제 큐(PAY_REQUEST)로 최종 발행
                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(paymentData)), 
                    { 
                        persistent: true,
                        contentType: 'application/json'
                    }
                );

                console.log(`✅ [Relay Success] 예약건 결제 서버로 중계 완료: ${paymentData.orderId}`);
                channel.ack(msg);

            } catch (err) {
                console.error("❌ 예약 중계 실패:", err.message);
                channel.nack(msg, false, false);
            }
        });

    } catch (err) {
        console.error("❌ Consumer 초기화 에러:", err.message);
    }
}

module.exports = startConsumer;