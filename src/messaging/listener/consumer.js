// src/messaging/listener/consumer.js
// 중앙 설정파일에서 큐 이름, 익스체인지, 라우팅 키 및 커넥션 공유 함수를 가져옴
const { QUEUES, EXCHANGE, ROUTING_KEYS, getConnection } = require('../../config/rabbitMQ');

/**
 * [메인 중계 컨슈머 시작]
 * 내부 예약/환불 이벤트를 감시하고 결제 서비스(Java/Spring 등)로 데이터를 가공하여 전달함
 */
async function startConsumer() {
    try {
        // 1. [커넥션 재사용] rabbitMQ.js에 열려있는 물리적 연결을 그대로 사용함
        const connection = getConnection();
        if (!connection) throw new Error("RabbitMQ 연결이 안 되어 있어.");

        // 2. [채널 생성] 중계 작업을 위한 독립적인 논리 통로 개설
        const channel = await connection.createChannel();

        // 3. [인프라 선언] 예약, 환불, 결제 요청에 필요한 큐들을 선언 (durable: 메시지 보존)
        await channel.assertQueue(QUEUES.RESERVATION, { durable: true });
        await channel.assertQueue(QUEUES.REFUND_REQUEST, { durable: true });
        await channel.assertQueue(QUEUES.PAY_REQUEST, { durable: true });

        /**
         * 4. [바인딩 설정]
         * 익스체인지로 들어온 메시지가 각 큐로 정확히 배달되도록 이정표(라우팅 키)를 연결함
         */
        await channel.bindQueue(QUEUES.RESERVATION, EXCHANGE, QUEUES.RESERVATION);
        await channel.bindQueue(QUEUES.REFUND_REQUEST, EXCHANGE, QUEUES.REFUND_REQUEST);
        await channel.bindQueue(QUEUES.PAY_REQUEST, EXCHANGE, ROUTING_KEYS.PAY_REQUEST);

        console.log(`👷 [Consumer] 구독 중: ${QUEUES.RESERVATION}, ${QUEUES.REFUND_REQUEST}`);

        /**
         * [A. 예약 요청 처리 루프]
         * 예약 생성 이벤트가 발생하면 결제 요청용 DTO로 변환하여 결제 큐로 던짐
         */
        channel.consume(QUEUES.RESERVATION, async (msg) => {
            if (!msg) return;
            // 내부 예약 데이터 파싱
            const data = JSON.parse(msg.content.toString());
            
            try {
                // 결제 서버(Spring 등)의 규격에 맞춰 필드명 매핑 (데이터 변환)
                const paymentData = {
                    orderId: data.ticket_code,   // 주문 번호
                    memberId: data.member_id,    // 회원 ID
                    amount: data.total_price,    // 결제 금액
                    type: "PAYMENT",             // 요청 타입 구분
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE // 결과를 돌려받을 주소 지정
                };

                // 5. [결제 요청 발행] 가공된 데이터를 결제 요청 전용 라우팅 키로 발행
                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(paymentData)), 
                    { 
                        persistent: true, 
                        contentType: 'application/json' // Java 서버 인식을 위한 컨텐츠 타입 명시
                    }
                );

                // 성공적으로 중계했으므로 원본 메시지 삭제
                channel.ack(msg);
            } catch (err) {
                console.error("❌ 예약 처리 에러:", err.message);
                // 실패 시 다시 큐에 넣지 않고 폐기
                channel.nack(msg, false, false);
            }
        });

        /**
         * [B. 환불 요청 처리 루프]
         * 환불 신청 이벤트가 발생하면 결제 취소용 DTO로 변환하여 결제 큐로 던짐
         */
        channel.consume(QUEUES.REFUND_REQUEST, async (msg) => {
            if (!msg) return;
            // 내부 환불 데이터 파싱
            const data = JSON.parse(msg.content.toString());
            
            try {
                // 결제 서버 규격에 맞춘 환불 데이터 구성
                const refundData = {
                    orderId: data.ticket_code,   // 주문 번호
                    memberId: data.member_id,    // 회원 ID
                    amount: data.cancel_amount,  // 환불 예정 금액
                    type: "REFUND",              // 요청 타입 구분
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE // 결과 수신 주소
                };

                // 6. [결제 취소 요청 발행] 동일한 결제 요청 키를 쓰되 'type'으로 구분하여 발송
                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(refundData)), 
                    { 
                        persistent: true, 
                        contentType: 'application/json' 
                    }
                );
                
                // 중계 완료 후 메시지 삭제
                channel.ack(msg);
            } catch (err) {
                console.error("❌ 환불 처리 에러:", err.message);
                channel.nack(msg, false, false);
            }
        });

    } catch (err) {
        // 커넥션 오류 등 초기화 실패 시 에러 출력
        console.error("❌ Consumer 에러:", err.message);
    }
}

module.exports = startConsumer;