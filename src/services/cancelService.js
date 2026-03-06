// src/services/cancelService.js

const resRepository = require('../repositories/resRepository');
const redis = require('../config/redisClient');

/**
 * [보상 트랜잭션 전담 서비스]
 * 결제 서버의 응답 실패나 타임아웃 발생 시, 시스템 전체의 데이터 일관성을 맞추기 위해 
 * 이미 실행된 재고 차감 및 예약 생성을 무효화하는 로직을 수행함.
 */
const cancelService = {
    /**
     * 결제 실패/시간 초과 시 DB 상태 변경 및 Redis 재고 복구
     */
    handleCompensation: async ({ ticket_code, event_id, ticket_count }) => {
        try {
            /**
             * [데이터 타입 정규화]
             * RabbitMQ(MQ) 메시지로부터 전달받은 값들은 직렬화 과정에서 문자열로 변환될 수 있음.
             * 연산의 정확성을 기하고 DB 쿼리 시 타입 불일치 에러를 막기 위해 숫자로 명시적 형변환을 수행함.
             */
            const count = parseInt(ticket_count, 10);
            const eventId = parseInt(event_id, 10);

            /**
             * [1단계: 관계형 DB(PostgreSQL) 롤백]
             * 리포지토리의 트랜잭션 함수를 호출하여 예약 상태를 'FAILED'로 변경하고,
             * DB 상의 잔여 좌석(available_seats)을 다시 증가시킴.
             * 이는 영구 저장소의 데이터 무결성을 회복하는 단계임.
             */
            await resRepository.cancelReservationAndRestoreStock(ticket_code, eventId, count);
            
            /**
             * [2단계: 인메모리 DB(Redis) 롤백]
             * 선착순 티켓팅 시 선차감했던 Redis의 실시간 재고를 incrBy 명령어로 즉시 복구함.
             * 이 과정이 완료되어야 다른 대기 사용자들이 취소된 좌석을 다시 구매할 수 있게 됨.
             */
            const stockKey = `event:stock:${eventId}`;
            await redis.incrBy(stockKey, count);
            
            // [결과 기록] 복구 작업이 성공적으로 완료되었음을 로깅하여 운영 관제 시 추적 가능하게 함
            console.log(`✅ [Rollback Success] 티켓:${ticket_code} / 복구수량:${count}`);
        } catch (error) {
            /**
             * [치명적 에러 핸들링]
             * 보상 트랜잭션 자체가 실패하는 경우(DB 연결 유실 등) 로그를 남겨 긴급 조치가 가능하게 함.
             */
            console.error('❌ [Rollback Fail] 보상 트랜잭션 중 치명적 에러:', error.message);

            /**
             * [상위 전파]
             * 에러를 throw하여 호출자인 consumer가 nack을 발생시키도록 유도함.
             * 이를 통해 메시지가 버려지지 않고 다시 큐에 쌓여 재시도(Retry)될 수 있는 구조를 만듦.
             */
            throw error; 
        }
    }
};

module.exports = cancelService;