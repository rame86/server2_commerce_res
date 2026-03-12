// src/messaging/listener/consumer.js
// 중앙 설정파일에서 큐 이름, 익스체인지, 라우팅 키 및 커넥션 공유 함수를 가져옴
const { QUEUES, EXCHANGE, ROUTING_KEYS, getConnection } = require('../../config/rabbitMQ');

/**
 * [메인 중계 컨슈머 시작]
 * 내부 예약/환불 이벤트를 감시하고 결제 서비스(Java/Spring 등)로 데이터를 가공하여 전달함
 */
async function startConsumer() {
    try {
        // 1. [커넥션 재사용] rabbitMQ.js에 이미 열려있는 물리적 연결(TCP)을 그대로 가져옴
        const connection = getConnection();
        if (!connection) throw new Error("RabbitMQ 연결이 안 되어 있어.");

        // 2. [채널 생성] 중계 작업을 위한 독립적인 논리 통로 개설
        const channel = await connection.createChannel();

        // 3. [인프라 선언] 사용할 큐들이 RabbitMQ 서버에 존재하는지 확인 (없으면 자동 생성)
        // durable: true는 RabbitMQ 서버가 꺼져도 메시지 목록을 기억하라는 설정임
        await channel.assertQueue(QUEUES.RESERVATION, { durable: true });
        await channel.assertQueue(QUEUES.REFUND_REQUEST, { durable: true });
        await channel.assertQueue(QUEUES.PAY_REQUEST, { durable: true });

        /**
         * 4. [바인딩 설정]
         * 우체국(Exchange)으로 들어온 메시지가 주소(Routing Key)에 맞게
         * 각 우체통(Queue)으로 쏙 들어가도록 연결해주는 이정표 작업
         */
        await channel.bindQueue(QUEUES.RESERVATION, EXCHANGE, QUEUES.RESERVATION);
        await channel.bindQueue(QUEUES.REFUND_REQUEST, EXCHANGE, QUEUES.REFUND_REQUEST);
        await channel.bindQueue(QUEUES.PAY_REQUEST, EXCHANGE, ROUTING_KEYS.PAY_REQUEST);

        console.log(`👷 [Consumer] 구독 중: ${QUEUES.RESERVATION}, ${QUEUES.REFUND_REQUEST}`);

         /* [A. 예약 요청 처리 루프]
         * 예약 서비스에서 온 날것의 데이터를 Java 결제 서버가 이해할 수 있는 규격(DTO)으로 바꿈
         */
        channel.consume(QUEUES.RESERVATION, async (msg) => {
            // 1. 메시지가 비어있으면(RabbitMQ 연결 끊김 등) 바로 종료
            if (!msg) return;

            // 2. 큐에서 받은 버퍼 데이터를 JSON 객체로 파싱 (예약 정보 데이터)
            const data = JSON.parse(msg.content.toString());
            
            try {
                /**
                 * 3. [비즈니스 정책 검증: 수량 제한]
                 * 예약 생성 단계에서 걸러졌겠지만, 데이터 정합성을 위해 중계 단계에서 한 번 더 확인.
                 * 티켓 수량이 2개를 초과하면 결제 요청을 진행하지 않고 무시함.
                 */
                if (data.ticket_count > 2) {
                    console.error(`⚠️ [Warn] 1인당 예매 제한(2매) 초과 발견 - 코드: ${data.ticket_code}, 수량: ${data.ticket_count}개`);
                    // channel.ack(msg): 메시지는 확인 처리하여 큐에서 제거하지만, 결제 큐(publish)로는 던지지 않음
                    return channel.ack(msg); 
                }

                // 4. [기본값 세팅] 계산 오류 방지를 위해 값이 없을 경우 기본값(Default)을 설정
                const quantity = data.ticket_count || 1; // 최소 1개 보장
                const totalPrice = data.total_price || 0; // 결제 총액
                const bookingFee = data.booking_fee || 0; // 예매 수수료

                /**
                 * 5. [Java 서버 규격 변환]
                 * Java 결제 서버의 DTO 필드(BigDecimal, Integer 등)에 맞춰 데이터를 매핑함.
                 * 정산/검증을 위해 금액을 '원가'와 '수수료'로 쪼개서 전송. BigInt나 Decimal 처리를 위해 숫자로 형변환(Number) 진행
                 */
                const paymentData = {
                    orderId: data.ticket_code,        // 결제 식별값 (티켓 유니크 코드)
                    memberId: data.member_id,         // 결제 주체 (회원 ID)
                    amount: totalPrice,               // 총 결제 금액 (원가 + 수수료)
                    
                    // 🌟 원가 계산: 별도 DB 조회 없이 (총액 - 수수료) 산술 연산으로 도출
                    originalAmount: totalPrice - bookingFee,                
                    fee: bookingFee,                  // 플랫폼 예매 수수료
                    shippingFee: 0,                   // 배송비 (티켓 서비스 특성상 0원 고정)
                    quantity: quantity,               // 티켓 구매 수량
                    type: "PAYMENT",                  // 요청 종류 (결제/환불 구분용)                  
                    // 결과 피드백을 받을 라우팅 키 (결제 성공/실패 시 이 주소로 다시 응답이 옴)
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE 
                };

                // 6. [결제 큐로 데이터 전송] 가공된 결제 요청 정보를 결제 전용 큐(PAY_REQUEST)로 발행
                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(paymentData)), 
                    { 
                        persistent: true,             // 메시지 영속성 (서버가 꺼져도 메시지 보존)
                        contentType: 'application/json' // Java 서버(Spring)의 Jackson이 인식하도록 명시
                    }
                );

                // 7. [성공 확인] 중계가 완료되었으므로 원본 예약 메시지를 큐에서 최종 삭제
                console.log(`✅ [Relay Success] 주문번호: ${paymentData.orderId}, 원가: ${paymentData.originalAmount}원 중계 완료`);
                channel.ack(msg);

            } catch (err) {
                /**
                 * 8. [예외 처리]
                 * 로직 수행 중 에러 발생 시 로그를 남기고 메시지를 큐로 되돌리지 않음(nack)
                 * nack(msg, false, false): 재시도 없이 폐기 (Dead Letter Queue 설정 시 거기로 이동 가능)
                 * (내부 로직 에러 시 로그만 남기고 메시지는 삭제(nack)하여 무한 루프 방지)
                 */
                console.error("❌ 결제 중계 실패:", err.message);
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

                // [결제 취소 요청 발행] 동일한 결제 요청 키를 쓰되 'type'으로 구분하여 발송 (결제 서버가 듣고 있는 큐로 전송)
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
                console.log(`♻️ [환불 중계 완료] 주문번호: ${refundData.orderId}`);
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