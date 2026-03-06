// src/messaging/listener/consumer.js
const amqp = require('amqplib');
const { QUEUES, EXCHANGE, ROUTING_KEYS } = require('../../config/rabbitMQ');

/**
 * [메인 컨슈머 프로세스]
 * 예약 서버가 내부적으로 처리해야 할 예약 및 환불 메시지를 감시하고,
 * 이를 외부 결제 서버가 이해할 수 있는 포맷으로 가공하여 중계(Relay)함.
 */
async function startConsumer() {
    // [연결 설정] 환경 변수를 조합하여 RabbitMQ 서버 접속 URL을 생성함
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        // [커넥션 확보] RabbitMQ 서버와 연결을 맺고 통신 채널을 생성함
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        /**
         * [1. 큐 선언 및 영속화]
         * 예약(RESERVATION), 환불 요청(REFUND_REQUEST), 결제 요청(PAY_REQUEST) 큐를 생성함.
         * durable: true 설정을 통해 메시지 브로커가 재시작되어도 큐 데이터가 손실되지 않게 보장함.
         */
        await channel.assertQueue(QUEUES.RESERVATION, { durable: true });
        await channel.assertQueue(QUEUES.REFUND_REQUEST, { durable: true });
        await channel.assertQueue(QUEUES.PAY_REQUEST, { durable: true });

        /**
         * [🚨 2. 바인딩(Binding) 설정]
         * 우체국(Exchange)에 도착한 메시지가 어떤 우편함(Queue)으로 들어가야 할지 길을 정해주는 작업임.
         * 특정 라우팅 키(Routing Key)와 큐를 매핑하여 메시지가 정확한 목적지를 찾게 함.
         */
        await channel.bindQueue(QUEUES.RESERVATION, EXCHANGE, QUEUES.RESERVATION);
        await channel.bindQueue(QUEUES.REFUND_REQUEST, EXCHANGE, QUEUES.REFUND_REQUEST);
        await channel.bindQueue(QUEUES.PAY_REQUEST, EXCHANGE, ROUTING_KEYS.PAY_REQUEST);

        console.log(`👷 [Consumer] 구독 중: ${QUEUES.RESERVATION}, ${QUEUES.REFUND_REQUEST}`);

        /**
         * [A. 예약 요청 처리 루프]
         * 사용자가 예약을 시도하면 발생하는 메시지를 처리함
         */
        channel.consume(QUEUES.RESERVATION, async (msg) => {
            // [데이터 수신] 메시지가 비어있으면 즉시 리턴함
            if (!msg) return;
            // [역직렬화] 버퍼 형태의 데이터를 JSON 객체로 파싱하여 예약 정보를 읽음
            const data = JSON.parse(msg.content.toString());
            
            try {
                /**
                 * [결제 서버용 페이로드 구성]
                 * 결제 서버(Spring 기반 등)가 요구하는 표준 규격에 맞춰 필드명을 매핑함.
                 * 특히 결제가 끝나고 돌아올 주소(replyRoutingKey)를 함께 전달하는 것이 포인트임.
                 */
                const paymentData = {
                    orderId: data.ticket_code,
                    memberId: data.member_id,
                    amount: data.total_price,
                    type: "PAYMENT",
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
                };

                console.log("🚀 [MQ 전송 직전 데이터]:", JSON.stringify(paymentData, null, 2));

                /**
                 * [메시지 발행(Publish)] 
                 * 결제 요청을 처리하는 전용 익스체인지와 라우팅 키를 통해 메시지를 쏘아 올림.
                 */
                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(paymentData)), 
                    { 
                        // [메시지 손실 방지] 디스크에 메시지를 기록하여 안전하게 전송함
                        persistent: true,
                        // [🚨 상호운용성 핵심] 전송하는 데이터가 JSON임을 명시하여, 
                        // 수신 측(예: Java/Spring Boot)에서 별도의 변환 없이 객체로 바로 받을 수 있게 함.
                        contentType: 'application/json' 
                    }
                );

                // [수신 확인] 메시지를 정상 처리했음을 브로커에 알리고 큐에서 삭제함
                channel.ack(msg);
            } catch (err) {
                console.error("❌ 예약 처리 에러:", err.message);
                // [오류 처리] 실패 시 메시지를 큐에서 제거하고 버림 (nack 사용)
                channel.nack(msg, false, false);
            }
        });

        /**
         * [B. 환불 요청 처리 루프]
         * 사용자가 환불을 요청했을 때 발생하는 메시지를 처리함
         */
        channel.consume(QUEUES.REFUND_REQUEST, async (msg) => {
            if (!msg) return;
            const data = JSON.parse(msg.content.toString());
            
            try {
                /**
                 * [환불 전용 데이터 가공]
                 * 결제 취소 요청을 위해 필요한 주문 코드와 환불 금액 정보를 세팅함.
                 */
                const refundData = {
                    orderId: data.ticket_code,
                    memberId: data.member_id,
                    amount: data.cancel_amount,
                    type: "REFUND",
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
                };

                /**
                 * [결제 취소 메시지 전송]
                 * 예약과 마찬가지로 'PAY_REQUEST' 채널을 통해 전송하되, type 값을 'REFUND'로 구분함.
                 */
                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(refundData)), 
                    { 
                        persistent: true,
                        // [🚨 환불 쪽 필수 설정] Spring Jackson 라이브러리가 자동으로 JSON을 파싱할 수 있도록 함.
                        contentType: 'application/json' 
                    }
                );
                
                channel.ack(msg);
            } catch (err) {
                console.error("❌ 환불 처리 에러:", err.message);
                channel.nack(msg, false, false);
            }
        });

    } catch (err) {
        console.error("❌ RabbitMQ Consumer 연결 실패:", err);
    }
}

module.exports = startConsumer;