// src/services/resService.js
/**
 * FanVerse - Reservation Service Layer
 * 수정 사항: Redis 기반 실시간 재고(event) 검증 및 차감 로직 추가
 */

const resRepository = require('../repositories/resRepository');
const redis = require('../config/redisClient');
const amqp = require('amqplib');
// 💡 [핵심] 이 파일에서도 환경변수를 읽을 수 있게 최상단에 추가
require('dotenv').config();
/**
 * [핵심: 모든 이벤트 재고 Redis Warm-up]
 * DB의 모든 이벤트를 가져와서 Redis에 저장 (서버 시작 시 호출)
 */
exports.warmupAllEventsToRedis = async () => {
    // 1. Repository에서 전체 리스트 조회
    const allEvents = await resRepository.findAllEvents();

    if (!allEvents || allEvents.length === 0) {
        console.warn("⚠️ [Warm-up] DB에 로드할 이벤트가 없습니다.");
        return;
    }

    // 2. 루프를 돌며 Redis에 SET (Key: event:stock:ID)
    for (const event of allEvents) {
        const key = `event:stock:${event.event_id}`;
        await redis.set(key, event.available_seats);
    }
    console.log(`🚀 [Redis] ${allEvents.length}개 이벤트 동기화 완료`);
};

/**
 * [관리자용 또는 서버 시작용: Redis 재고 초기 세팅]
 * 이 코드가 실행되어야 Redis에 'event' 메모리가 생성됨
 */
exports.initEventStock = async (eventId, stockCount) => {
    const key = `event:stock:${eventId}`;
    await redis.set(key, stockCount);
    // 핵심 주석: 초기 재고 데이터를 Redis에 세팅 (이벤트 시작 전 필수)
    return { eventId, stockCount };
};

// src/services/resService.js

exports.validateAndPrepare = async (eventId, count, memberId) => {
    const stockKey = `event:stock:${eventId}`;
    
    // 1. Redis에서 유저 정보(Hash) 가져오기
    const userKey = `AUTH:MEMBER:${memberId}`;
    const userProfile = await redis.hGetAll(userKey);

    if (!userProfile || Object.keys(userProfile).length === 0) {
        throw { status: 401, message: "유저 정보를 찾을 수 없습니다." };
    }

    // [핵심 수정] 문자열인 balance를 숫자로 확실하게 변환
    const userBalance = parseInt(userProfile.balance, 10) || 0; 
    console.log(`💰 디버깅 - 보유 잔액: ${userBalance}, 필요 포인트 계산 시작`);

    // 2. 이벤트 정보 조회 및 가격 계산
    const event = await resRepository.findEventById(eventId);
    if (!event) {
        throw { status: 404, message: "공연 정보를 찾을 수 없습니다." };
    }

    // 총 가격 = (티켓 가격 * 수량) + (수수료 1000원 * 수량)
    const totalPrice = (event.price * count) + (count * 1000);

    // 3. 포인트 잔액 검증
    if (userBalance < totalPrice) {
        // 에러 메시지에 보유 포인트가 0으로 나오지 않게 userBalance를 정확히 전달
        throw { 
            status: 400, 
            message: `포인트가 부족합니다. (필요: ${totalPrice}P / 보유: ${userBalance}P)` 
        };
    }

    const ticketCode = `TKT-${Math.floor(Math.random() * 90000) + 10000}`;

    return {
        totalPrice,
        ticketCode,
        eventTitle: event.title
    };
};

// exports.validateAndPrepare = async (eventId, count, memberId) => {
//     // 1. Redis에서 실시간 재고 확인 및 선차감
//     const stockKey = `event:stock:${eventId}`;
//     const remainingStock = await redis.decrBy(stockKey, count);

//     // 재고 부족 시 롤백 및 차단
//     if (remainingStock < 0) {
//         await redis.incrBy(stockKey, count);
//         throw { status: 400, message: "선착순 마감되었습니다. 재고가 부족합니다." };
//     }

//     try {
//         /* [수정 포인트]
//         * 이미지의 Key 구조: AUTH:MEMBER:${memberId}
//         * 데이터 타입: Hash*/
//         const userKey = `AUTH:MEMBER:${memberId}`;
//         const userProfile = await redis.hGetAll(userKey); // Hash 데이터를 객체로 가져옴
        
//         if (!userProfile || Object.keys(userProfile).length === 0) {
//             // 유저 정보가 Redis에 없으면 재고 복구 후 에러 반환
//             await redis.incrBy(stockKey, count);
//             throw { status: 404, message: "유저 포인트 정보를 찾을 수 없습니다. 다시 로그인해주세요." };
//         }

//        // 이미지에서 'balance' 필드명을 사용하므로 이를 숫자로 변환
//         const userBalance = parseInt(userProfile.balance, 10);
//         // 데이터 전체와 포인트 잔액을 각각 확인
//         console.log("👤 가져온 유저 정보:", userProfile);
//         console.log("💰 현재 잔액(balance):", userProfile.balance);

//         // 3. 이벤트 상세 정보 조회 (금액 계산용)
//         const event = await resRepository.findEventById(eventId);
//         if (!event) {
//             await redis.incrBy(stockKey, count);
//             throw { status: 404, message: "공연 정보를 찾을 수 없습니다." };
//         }

//         // 수수료 포함 총 금액 계산 (티켓당 1,000원 추가)
//         const totalPrice = (event.price * count) + (count * 1000);

//         // 4. [핵심] 포인트 잔액 검증
//         // userProfile 객체 안에 points 필드가 숫자로 들어있어야 함
//         if (!userProfile.points || userProfile.points < totalPrice) {
//             await redis.incrBy(stockKey, count);
//             throw { status: 400, message: `포인트가 부족합니다. (필요: ${totalPrice}P / 보유: ${userProfile.points || 0}P)` };
//         }

//         // 5. 티켓 코드 생성 (TKT-XXXXX)
//         const ticketCode = `TKT-${Math.floor(Math.random() * 90000) + 10000}`;

//         return {
//             totalPrice,
//             ticketCode,
//             eventTitle: event.title,
//             remainingStock
//         };

//     } catch (err) {
//         // 내부 로직 중 에러 발생 시 차감했던 재고 반드시 복구
//         if (err.status !== 400 && err.status !== 404) {
//             await redis.incrBy(stockKey, count);
//         }
//         throw err;
//     }
// };

/**
 * [티켓 예매 실행]
 */
exports.makeReservation = async (resData, memberId) => {
    //입력받은 원시 데이터를 가공하고 타입을 맞추는 '비즈니스 준비' 단계
    const dbData = {
        event_id: parseInt(resData.event_id, 10),
        ticket_count: parseInt(resData.ticket_count, 10),
        member_id: memberId,
        total_price: resData.total_price,
        ticket_code: resData.ticket_code
    };

    // 준비된 데이터를 들고 Repository(창고지기)에게 저장을 요청함
    // DB 저장 (이미 Redis에서 재고 검증이 끝났으므로 안전하게 입력)
    const dbResult = await resRepository.createReservationWithTransaction(dbData);

    return JSON.parse(JSON.stringify(dbResult, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    ));
};

// [사용자 환불 처리 및 결제 서버 통보]
exports.processRefund = async (reservation) => {
    // 1. 필요한 데이터 추출
    const { ticket_code, member_id, total_price } = reservation;

    // 2. RabbitMQ 접속 정보 설정 (오타 수정 및 환경변수 우선순위 적용)
    const mqUser = process.env.RABBITMQ_USER || 'guest';
    const mqPass = process.env.RABBITMQ_PASSWORD || 'guest';
    const mqHost = process.env.RABBITMQ_HOST || 'localhost';
    
    // .env에 RABBITMQ_URL이 있으면 그걸 쓰고, 없으면 조합해서 사용
    const rabbitUrl = process.env.RABBITMQ_URL || `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

    console.log("-----------------------------------------");
    console.log("♻️ [Service 환불 시도] MQ_URL:", rabbitUrl);
    console.log("-----------------------------------------");

    if (!ticket_code) {
        throw new Error("환불에 필요한 티켓 코드가 없습니다.");
    }

    let connection;
    try {
        // 3. RabbitMQ 연결 (여기서 오타 해결!)
        connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        const TARGET_QUEUE = 'pay.request.queue'; // Spring 결제 서버와 약속된 큐 이름

        // 4. 전송할 데이터 포맷팅 (Spring DTO 구조에 맞춤)
        const refundPayload = {
            type: "REFUND",
            orderId: ticket_code,
            memberId: Number(member_id),
            amount: Number(total_price),
            replyRoutingKey: "res.status.update"
        };

        // 5. 큐 확인 및 메시지 전송
        await channel.assertQueue(TARGET_QUEUE, { durable: true });
        
        const isSent = channel.sendToQueue(
            TARGET_QUEUE,
            Buffer.from(JSON.stringify(refundPayload)),
            { 
                persistent: true, // 서버 꺼져도 메시지 보존
                contentType: 'application/json' 
            }
        );

        if (isSent) {
            console.log(`✅ [성공] Spring으로 환불 데이터 발송 완료: ${ticket_code}`);
        }

        // 6. 연결 종료 (잠시 대기 후 안전하게 닫기)
        setTimeout(async () => {
            await channel.close();
            await connection.close();
        }, 500);

    } catch (error) {
        // 인증 실패(403) 시 URL과 권한 다시 확인할 것
        console.error("❌ [환불 서비스 오류] MQ 접속 실패:", error.message);
        throw error;
    }
};