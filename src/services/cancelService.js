// src/services/cancelService.js

const resRepository = require('../repositories/resRepository');
const redis = require('../config/redisClient');

/**
 * [보상 트랜잭션 전담 서비스]
 */
const cancelService = {
    /**
     * 결제 실패/시간 초과 시 DB 상태 변경 및 Redis 재고 복구
     */
    handleCompensation: async ({ ticket_code, event_id, ticket_count }) => {
        try {
            // 핵심 주석: MQ에서 JSON 파싱 시 문자열로 넘어올 수 있으므로 명시적 형변환 (하드코딩 방지)
            const count = parseInt(ticket_count, 10);
            const eventId = parseInt(event_id, 10);

            // 1. DB 롤백: 예약 취소 상태 변경 및 DB 재고 증감
            // 💡 주의: Repository 내에서 "상태가 이미 FAILED/CANCELED가 아닐 때만" 업데이트하도록 쿼리 방어 필수!
            await resRepository.cancelReservationAndRestoreStock(ticket_code, eventId, count);
            
            // 2. Redis 롤백: 선차감했던 재고 다시 복구
            const stockKey = `event:stock:${eventId}`;
            await redis.incrBy(stockKey, count);
            
            console.log(`✅ [Rollback Success] 티켓:${ticket_code} / 복구수량:${count}`);
        } catch (error) {
            console.error('❌ [Rollback Fail] 보상 트랜잭션 중 치명적 에러:', error.message);
            // 핵심 주석: 에러를 던져야 컨슈머(cancelConsumer.js)의 catch 블록으로 넘어가서 nack(재시도) 처리가 됨
            throw error; 
        }
    }
};

module.exports = cancelService;