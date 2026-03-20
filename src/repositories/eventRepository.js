/**
 * FanVerse - Event Repository Layer
 * 담당: Prisma를 이용한 공연 관련 PostgreSQL(Server 1) 데이터 제어
 */

const prisma = require('../config/prisma');

/**
 * [Redis Warm-up용 DB 재고 조회]
 */
exports.getEventStock = async (eventId) => {
    try {
        const targetEvent = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            select: { available_seats: true }
        });
        return targetEvent ? targetEvent.available_seats : 0;
    } catch (err) {
        console.error("❌ [getEventStock Error]:", err.message);
        throw err;
    }
};

/**
 * [특정 공연 조회]
 */
exports.findEventById = async (eventId) => {
    return await prisma.events.findUnique({
        where: { 
            event_id: parseInt(eventId, 10),
            approval_status: 'CONFIRMED' 
        }
    });
};

// [src/repositories/eventRepository.js]

/**
 * [유저용] 승인된 모든 공연 목록 조회
 */
exports.findAllEvents = async () => {
    return await prisma.events.findMany({ 
        where: { approval_status: 'CONFIRMED' }, // 무조건 승인된 것만
        include: {
            event_locations: true,
            event_images: true,
            reservations: {
                where: { status: 'CONFIRMED' },
                select: { ticket_count: true }
            }
        },
        orderBy: { event_date: 'asc' }
    });
};

/**
 * [유저용] 승인된 모든 공연 목록 조회
 */
exports.findAllEvents = async () => {
    return await prisma.events.findMany({ 
        where: { approval_status: 'CONFIRMED' }, // 무조건 승인된 것만
        include: {
            event_locations: true,
            event_images: true,
            reservations: {
                where: { status: 'CONFIRMED' },
                select: { ticket_count: true }
            }
        },
        orderBy: { event_date: 'asc' }
    });
};

/**
 * [아티스트용] 본인이 신청한 모든 공연 조회 (상태 상관없음)
 */
exports.findArtistEvents = async (artistId) => {
    return await prisma.events.findMany({ 
        where: { artist_id: BigInt(artistId) }, // 내 것만
        include: {
            event_locations: true,
            event_images: true,
            reservations: {
                where: { status: 'CONFIRMED' },
                select: { ticket_count: true }
            }
        },
        orderBy: { created_at: 'desc' } // 최신 신청순
    });
};


/**
 * [공연 등록 신청 - Repository] 
 * 수정 사항: 이미지(event_images) 저장 로직 추가
 */
exports.createEventRequest = async (data) => {
    return await prisma.$transaction(async (tx) => {
        // 1. 공연 기본 정보 생성 (PENDING 상태)
        const newEvent = await tx.events.create({
            data: {
                title: data.title,
                description: data.description,
                price: data.price,
                total_capacity: data.total_capacity,
                available_seats: data.total_capacity,
                category: data.category,
                event_date: new Date(data.event_date),
                approval_status: 'PENDING',
                member_id: (data.member_id !== undefined && data.member_id !== null) 
                            ? BigInt(data.member_id) 
                            : null
            }
        });

        // 2. 공연 위치 정보 저장
        await tx.event_locations.create({
            data: {
                event_id: newEvent.event_id,
                venue_name: data.venue,
                address: data.address,
                latitude: data.lat,         // 🌟 lat -> latitude
                longitude: data.lng
            }
        });

        // 🌟 3. [추가] 공연 이미지 정보 저장
        // data.images가 배열로 들어온다고 가정 (예: [{url: '...', type: 'POSTER'}, ...])
        if (data.images && Array.isArray(data.images) && data.images.length > 0) {
            await tx.event_images.createMany({
                data: data.images.map(img => ({
                    event_id: newEvent.event_id,
                    image_url: img.url,
                    image_type: img.type || 'SUB' // 메인 포스터 여부 등을 구분
                }))
            });
        }

        // 4. 관리자 승인 대기열(event_approvals)에 등록
        await tx.event_approvals.create({
            data: {
                event_id: newEvent.event_id,
                status: 'PENDING'
            }
        });

        return newEvent;
    });
};

/**
 * [공연 승인 및 정보 반환]
 */
exports.confirmEvent = async (tx, eventId, adminId) => {
    if (!eventId) throw new Error("eventId가 유효하지 않습니다.");

    await tx.event_approvals.updateMany({
        where: { event_id: Number(eventId) },
        data: { 
            status: 'CONFIRMED', 
            // 💡 [방어 코드] admin_id가 undefined/null인 경우 BigInt 에러 방지
            admin_id: (adminId !== undefined && adminId !== null) ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });

    return await tx.events.update({
        where: { event_id: Number(eventId) },
        data: { approval_status: 'CONFIRMED' }
    });
};

/**
 * [공연 반려 처리]
 */
exports.rejectEvent = async (tx, eventId, adminId, reason) => {
    if (!eventId) throw new Error("eventId가 유효하지 않습니다.");

    await tx.event_approvals.updateMany({
        where: { event_id: Number(eventId) },
        data: { 
            status: 'FAILED', 
            rejection_reason: reason,
            // 💡 [방어 코드] admin_id 안전하게 처리
            admin_id: (adminId !== undefined && admin_id !== null) ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });

    return await tx.events.update({
        where: { event_id: Number(eventId) },
        data: { approval_status: 'FAILED' }
    });
};

/**
 * [정산 정책 조회]
 */
exports.getFeePolicy = async (eventId) => {
    return await prisma.event_fee_policies.findUnique({
        where: { event_id: parseInt(eventId, 10) }
    });
};

//유저 대시보드 이벤트 [내 예매 내역 조회]
exports.findConfirmedReservationsByUserId = async (userId) => {
    return await prisma.reservations.findMany({
        where: {
            user_id: BigInt(userId),
            status: 'CONFIRMED'
        },
        include: {
            events: {
                include: { event_locations: true }
            }
        }
    });
};