import xapi from 'xapi';

// ------------------------------------------------------------------------------------------------------------
// ------------------------------ 01. Configuration and RoomOS Values --------------------------------------
// ------------------------------------------------------------------------------------------------------------

const MACRO_INFO = Object.freeze({
    NAME: 'BookingAutoCancellation',
    VERSION: '0.1.4'
});

const CONFIG = {
    // Empty-room release policy
    EMPTY_ROOM_TIMEOUT_MS: 10 * 60 * 1000, // Advertised empty-room timeout before release eligibility
    PRE_TIMEOUT_WARNING_MS: 5 * 60 * 1000, // Show room use check prompt before the advertised timeout
    POST_TIMEOUT_GRACE_PERIOD_MS: 2 * 60 * 1000, // Extra time after the advertised timeout before Checkout

    // Long-meeting exemption and native RoomOS behavior
    LONG_MEETING_EXEMPTION_THRESHOLD_MS: 120 * 60 * 1000, // Meetings longer than this block autocancellation; set to 0 to disable
    NATIVE_CHECK_IN_WINDOW_MINUTES: 60, // Minutes before RoomOS releases an unchecked-in booking
    ULTRASOUND_SENSOR_ENABLED: false, // Set to true to include ultrasound in RoomOS presence fusion
    EARLY_DEPARTURE_RELEASE_ENABLED: false,

    // Execution mode
    AUTOMATIC_CHECK_IN_DELAY_MS: 3 * 1000, // Allow a concurrent user or RoomOS CheckIn event to arrive before one macro CheckIn
    BOOKING_READINESS_RECOVERY_DELAYS_MS: [250, 500, 1000, 2000, 4000],
    BOOKING_SYNC_COALESCE_DELAY_MS: 50, // Coalesce rapid BookedUntil and TimeStamp event bursts
    DRY_RUN_MODE: true,                 // If true, configures presence, disables native CheckIn, and suppresses booking commands and UI
    DEBUG: true                         // Set to true to enable debug logging
};

const ROOM_IN_USE_STATUS = Object.freeze({
    TRUE: 'True',
    FALSE: 'False'
});

const ROOM_USE_STATE = Object.freeze({
    OCCUPIED: 'Occupied',
    EMPTY: 'Empty',
    UNKNOWN: 'Unknown'
});

const BOOKING_STATUS = Object.freeze({
    FREE: 'Free',
    FREE_UNTIL: 'FreeUntil',
    BOOKED_UNTIL: 'BookedUntil'
});

const RELEASE_WORKFLOW_PHASE = Object.freeze({
    IDLE: 'Idle',
    COUNTDOWN_SCHEDULED: 'CountdownScheduled',
    PROMPT_PENDING: 'PromptPending',
    PROMPT_VISIBLE: 'PromptVisible'
});

const RELEASE_POLICY = Object.freeze({
    NO_SHOW: 'No-Show Release',
    EARLY_DEPARTURE: 'Early Departure Release'
});

const AUTOCANCELLATION_STATUS = Object.freeze({
    ALLOWED: 'Allowed',
    BLOCKED: 'Blocked'
});

const AUTOCANCELLATION_BLOCK_REASON = Object.freeze({
    NO_CURRENT_BOOKING: 'NoCurrentBooking',
    VERIFYING_MEETING_LENGTH: 'VerifyingMeetingLength',
    AWAITING_STARTUP_CHECK_IN: 'AwaitingStartupCheckIn',
    LONG_MEETING: 'LongMeeting',
    INVALID_LONG_MEETING_EXEMPTION_CONFIGURATION: 'InvalidLongMeetingExemptionConfiguration',
    REQUIRED_CONFIGURATIONS_UNAVAILABLE: 'RequiredConfigurationsUnavailable',
    ROOM_USE_STATUS_UNAVAILABLE: 'RoomUseStatusUnavailable',
    COULD_NOT_VERIFY_CURRENT_BOOKING: 'CouldNotVerifyCurrentBooking',
    NATIVE_CHECK_IN_SETTING_UNAVAILABLE: 'NativeCheckInSettingUnavailable',
    CODEC_TIME_UNAVAILABLE: 'CodecTimeUnavailable',
    CHECK_OUT_FAILED: 'CheckOutFailed'
});

const RETRYABLE_AUTOCANCELLATION_BLOCK_REASONS = Object.freeze({
    [AUTOCANCELLATION_BLOCK_REASON.REQUIRED_CONFIGURATIONS_UNAVAILABLE]: true,
    [AUTOCANCELLATION_BLOCK_REASON.ROOM_USE_STATUS_UNAVAILABLE]: true,
    [AUTOCANCELLATION_BLOCK_REASON.COULD_NOT_VERIFY_CURRENT_BOOKING]: true,
    [AUTOCANCELLATION_BLOCK_REASON.NATIVE_CHECK_IN_SETTING_UNAVAILABLE]: true,
    [AUTOCANCELLATION_BLOCK_REASON.CODEC_TIME_UNAVAILABLE]: true
});

const MEETING_LENGTH_CLASSIFICATION = Object.freeze({
    PENDING: 'Pending',
    SHORT: 'Short',
    LONG: 'Long',
    UNCLASSIFIABLE: 'Unclassifiable'
});

const RELEASE_CANCELLATION_REASON = Object.freeze({
    ROOM_CONFIRMED_IN_USE: 'room_confirmed_in_use',
    MATCHING_CHECK_IN: 'matching_check_in'
});

// Add a platform only after verifying that its OSD returns Prompt.Response for
// an actionable option. Other platforms use OSD for information only.
const INTERACTIVE_OSD_PLATFORMS = Object.freeze({
    'Desk Pro': true
});

const ROOM_USE_CHECK_PROMPT = Object.freeze({
    FEEDBACK_IDS: Object.freeze({
        WARNING_CONTROLLER: 'auto_release_warning_controller',
        CHECKOUT_CONFIRMATION_CONTROLLER: 'auto_release_confirm_controller',
        WARNING_OSD: 'auto_release_warning_osd',
        CHECKOUT_CONFIRMATION_OSD: 'auto_release_confirm_osd'
    }),
    WARNING: Object.freeze({
        TITLE: 'Keep this booking?',
        INITIAL: Object.freeze({
            CONTROLLER_TEXT: 'Room use hasn\'t been detected recently.<br>If the room is in use, select Keep Booking. Otherwise, it will be released automatically.',
            OSD_TEXT: 'Room use hasn\'t been detected recently.<br>Please confirm on the touch controller to keep this booking.'
        }),
        REPEATED: Object.freeze({
            CONTROLLER_TEXT: 'Room use is still not detected.<br>If the room is in use, select Keep Booking. Otherwise, it will be released automatically.',
            OSD_TEXT: 'Room use is still not detected.<br>Please confirm on the touch controller to keep this booking.'
        })
    }),
    CHECKOUT_CONFIRMATION: Object.freeze({
        TITLE: 'Check out',
        CONTROLLER_TEXT: 'Are you sure you want to check out? This will end your booking reservation and remove the meeting.',
        OSD_TEXT: 'Are you sure you want to check out? This will end your booking reservation and remove the meeting.',
        OPTIONS: Object.freeze({
            CANCEL: Object.freeze({
                ID: '1',
                LABEL: 'Cancel'
            }),
            CHECK_OUT: Object.freeze({
                ID: '2',
                LABEL: 'Check out'
            })
        })
    }),
    OPTIONS: Object.freeze({
        KEEP_BOOKING: Object.freeze({
            ID: '1',
            LABEL: 'Keep Booking'
        }),
        CHECK_OUT: Object.freeze({
            ID: '2',
            LABEL: 'Check Out'
        })
    }),
    AUDIO_ALERT: Object.freeze({
        SOUND: 'Announcement',
        VOLUME_LEVEL: 70,
        VOLUME_HOLD_MS: 4 * 1000,
        REPEAT_INTERVAL_MS: 60 * 1000
    })
});

// ------------------------------------------------------------------------------------------------------------
// ------------------------------------- 02. Runtime State ----------------------------------------------------
// ------------------------------------------------------------------------------------------------------------

let midnightHealthCheckTimer = null;
let pendingBookingSync = null;
let bookingSyncCoalescingTimer = null;
let bookingReadinessRecoveryTimer = null;
let bookingReadinessRecoveryAttempt = 0;
let bookingReadinessRecoveryGeneration = 0;
let bookingReadinessRecoveryExhausted = false;
let automaticCheckInTimer = null;
let nativeCheckInWriteQueue = Promise.resolve();
let isInitializing = false;
let hasReceivedActiveBookingEventWhileInitializing = false;

const roomUseCheckPromptSurface = {
    productPlatform: null,
    controllerCount: 0,
    connectedControllerIds: []
};

// Fail closed: until RoomOS state is current and verified, preserve the booking
// and block booking-changing actions. Generation markers invalidate stale reads
// and callbacks after the booking, observed state, or release workflow changes.
const bookingLifecycle = {
    booking: {
        // BookedUntil is the only status with a current booking. FreeUntil's
        // timestamp is the next booking start, not the current booking end.
        availabilityStatus: BOOKING_STATUS.FREE,
        currentBookingId: null,
        currentBookingStartTime: '',
        currentBookingEndTime: '',
        nextBookingStartTime: '',
        isBookedFromDevice: false
    },
    presence: {
        // Unknown is fail-closed and must never authorize release. Start
        // conservatively occupied until RoomOS provides a usable value.
        roomUseState: ROOM_USE_STATE.OCCUPIED,
        lastHandledRoomUseState: null,
        isRoomUseStatusSupported: false
    },
    freshness: {
        // These versions invalidate asynchronous reads and callbacks that no
        // longer describe the current RoomOS state.
        bookingGeneration: 0,
        runtimeStateVersion: 0
    },
    autocancellation: {
        // Only an identity-bound Allowed decision permits automatic CheckIn
        // or release.
        areRequiredConfigurationsHealthy: false,
        status: {
            status: AUTOCANCELLATION_STATUS.BLOCKED,
            blockReason: AUTOCANCELLATION_BLOCK_REASON.NO_CURRENT_BOOKING,
            bookingId: null,
            endTimestamp: '',
            desiredNativeCheckInEnabled: null,
            nativeCheckInSettingApplied: false
        }
    },
    checkIn: {
        // CheckIn observations and the one-attempt automatic CheckIn guard.
        // Separate IDs handle events that arrive before booking reconciliation.
        roomOsCheckedInBookingId: null,
        pendingRoomOsCheckedInBookingId: null,
        // Dry-run-only confirmation after simulating a successful automatic CheckIn.
        dryRunSimulatedCheckInBookingId: null,
        hasAttemptedAutomaticCheckIn: false
    },
    checkout: {
        pendingMacroCheckoutBookingId: null,
        pendingMacroCheckoutBookingGeneration: null,
        pendingMacroCheckoutEndTime: ''
    },
    releaseWorkflow: {
        // Workflow phase and policy tracking
        releasePhase: RELEASE_WORKFLOW_PHASE.IDLE,
        releasePolicy: null,
        releaseWorkflowGeneration: 0,

        // Timers and deadline tracking
        countdownTimer: null,
        promptExpiryTimer: null,
        promptAlertIntervalTimer: null,
        promptAlertVolumeRestoreTimer: null,
        isPromptAlertVolumeOverridden: false,
        promptExpiresAt: null,

        // Prompt surface presentation state
        controllerPromptDisplayed: false,
        osdPromptDisplayed: false,

        // User interaction and confirmation guard state
        hasUserSelectedKeepBooking: false,
        isAwaitingCheckOutConfirmation: false,
        isCheckOutInProgress: false
    }
};

// ------------------------------------------------------------------------------------------------------------
// ----------------------------- 03. State and Transitions --------------------------------------------------
// ------------------------------------------------------------------------------------------------------------

function isSameBookingLifecycle(bookingGenerationAtStart) {
    return bookingGenerationAtStart === bookingLifecycle.freshness.bookingGeneration;
}

function isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) {
    return releaseWorkflowGenerationAtStart === bookingLifecycle.releaseWorkflow.releaseWorkflowGeneration;
}

function isSameStatusEventVersion(runtimeStateVersionAtStart) {
    return runtimeStateVersionAtStart === bookingLifecycle.freshness.runtimeStateVersion;
}

function beginNewBookingLifecycle(preservePendingRoomOsCheckIn = false) {
    cancelBookingSyncCoalescing();
    cancelRoomUseCheckPrompt();
    cancelBookingReadinessRecovery();
    cancelAutomaticCheckIn();
    clearPendingMacroCheckout();
    bookingLifecycle.freshness.bookingGeneration += 1;
    bookingLifecycle.checkIn.roomOsCheckedInBookingId = null;
    bookingLifecycle.checkIn.dryRunSimulatedCheckInBookingId = null;
    bookingLifecycle.booking.currentBookingStartTime = '';
    bookingLifecycle.booking.isBookedFromDevice = false;
    bookingLifecycle.releaseWorkflow.hasUserSelectedKeepBooking = false;
    bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation = false;
    if (!preservePendingRoomOsCheckIn) {
        bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId = null;
    }
    resetAutocancellationStatus();
    bookingLifecycle.checkIn.hasAttemptedAutomaticCheckIn = false;
}

function consumePendingRoomOsCheckInForCurrentBooking() {
    if (bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId !== bookingLifecycle.booking.currentBookingId) {
        return false;
    }
    bookingLifecycle.checkIn.roomOsCheckedInBookingId = bookingLifecycle.booking.currentBookingId;
    bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId = null;
    return true;
}

// ------------------------------------------------------------------------------------------------------------
// ---------------------------- 04. Presence and Prompt Surfaces --------------------------------------------
// ------------------------------------------------------------------------------------------------------------

/**
 * Converts the RoomInUse xAPI status into an explicit room-use state.
 * Unknown values remain Unknown so the release path fails closed.
 */
function parseRoomUseState(status) {
    if (status === ROOM_IN_USE_STATUS.TRUE) {
        return ROOM_USE_STATE.OCCUPIED;
    }
    if (status === ROOM_IN_USE_STATUS.FALSE) {
        return ROOM_USE_STATE.EMPTY;
    }
    return ROOM_USE_STATE.UNKNOWN;
}

function isCurrentBookingActive() {
    return bookingLifecycle.booking.availabilityStatus === BOOKING_STATUS.BOOKED_UNTIL;
}

function isCurrentBookingInactive() {
    return bookingLifecycle.booking.availabilityStatus === BOOKING_STATUS.FREE ||
        bookingLifecycle.booking.availabilityStatus === BOOKING_STATUS.FREE_UNTIL;
}

function canUseInteractiveOsd() {
    return INTERACTIVE_OSD_PLATFORMS[roomUseCheckPromptSurface.productPlatform] === true;
}

function hasControllerRoomUseCheckPromptSurface() {
    return roomUseCheckPromptSurface.controllerCount > 0;
}

function getConnectedControllerIds(connectedDevices) {
    return connectedDevices
        .filter(device =>
            device.Status === 'Connected' &&
            device.Type === 'TouchPanel' &&
            device.Role === 'Controller'
        )
        .map((device, index) => device.ID || device.SerialNumber || device.NetworkAddress || `controller-${index}`)
        .sort();
}

function hasSameControllerIds(previousControllerIds, currentControllerIds) {
    return previousControllerIds.length === currentControllerIds.length &&
        previousControllerIds.every((controllerId, index) =>
            controllerId === currentControllerIds[index]);
}

async function refreshControllerRoomUseCheckPromptSurface() {
    const controllerWasAvailable = hasControllerRoomUseCheckPromptSurface();
    const connectedDevices = await xapi.Status.Peripherals.ConnectedDevice.get().catch(e => {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Connected peripheral inventory could not be read:',
            { error: e }
        );
        return null;
    });
    if (!Array.isArray(connectedDevices)) {
        roomUseCheckPromptSurface.connectedControllerIds = [];
        roomUseCheckPromptSurface.controllerCount = 0;
        if (bookingLifecycle.releaseWorkflow.controllerPromptDisplayed || controllerWasAvailable) {
            bookingLifecycle.releaseWorkflow.controllerPromptDisplayed = false;
            if (!CONFIG.DRY_RUN_MODE) {
                xapi.Command.UserInterface.Message.Prompt.Clear({
                    Target: 'Controller',
                    FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER
                }).catch(e => {
                    logger.warn(
                        LOG_EVENT.PROMPT,
                        '[BookingAutoCancellation] Controller room use check prompt could not be cleared after an inventory read failure:',
                        { target: 'Controller', error: e }
                    );
                });
            }
        }
        return;
    }

    const connectedControllerIds = getConnectedControllerIds(connectedDevices);
    const controllerInventoryChanged =
        !hasSameControllerIds(roomUseCheckPromptSurface.connectedControllerIds, connectedControllerIds);
    if (!controllerInventoryChanged) {
        return;
    }

    roomUseCheckPromptSurface.connectedControllerIds = connectedControllerIds;
    roomUseCheckPromptSurface.controllerCount = connectedControllerIds.length;
    logger.info(
        LOG_EVENT.PROMPT,
        `[BookingAutoCancellation] Connected controller inventory changed: ${connectedDevices.length} peripheral entries, ${roomUseCheckPromptSurface.controllerCount} controller Navigator(s).`
    );

    if (bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE) {
        return;
    }

    if (controllerWasAvailable) {
        bookingLifecycle.releaseWorkflow.controllerPromptDisplayed = false;
        if (!CONFIG.DRY_RUN_MODE) {
            xapi.Command.UserInterface.Message.Prompt.Clear({
                Target: 'Controller',
                FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER
            }).catch(e => {
                logger.warn(
                    LOG_EVENT.PROMPT,
                    '[BookingAutoCancellation] Controller room use check prompt could not be cleared after a peripheral inventory change:',
                    { target: 'Controller', error: e }
                );
            });
        }
    }
    refreshRoomUseCheckPromptPresentation();
}

// ------------------------------------------------------------------------------------------------------------
// --------------------------- 05. Booking State and Freshness -----------------------------------------------
// ------------------------------------------------------------------------------------------------------------

function getRoomUseCheckPromptTimeRemainingSeconds() {
    if (bookingLifecycle.releaseWorkflow.promptExpiresAt === null) {
        return 0;
    }
    return Math.max(0, Math.ceil((bookingLifecycle.releaseWorkflow.promptExpiresAt - Date.now()) / 1000));
}

function hasActionableRoomUseCheckPromptOwnership() {
    return (canUseInteractiveOsd() && bookingLifecycle.releaseWorkflow.osdPromptDisplayed) ||
        (hasControllerRoomUseCheckPromptSurface() && bookingLifecycle.releaseWorkflow.controllerPromptDisplayed);
}

/**
 * Reads the current RoomOS booking state as one snapshot. Availability.TimeStamp
 * means the current booking end under BookedUntil, but the next booking start
 * under FreeUntil; keeping those values separate prevents a future booking from
 * authorizing actions for a current booking.
 */
async function readCurrentBookingSnapshot(
    bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration,
    runtimeStateVersionAtStart = bookingLifecycle.freshness.runtimeStateVersion,
    allowBookingDetailsFallback = false
) {
    let availabilityStatus = await xapi.Status.Bookings.Availability.Status.get().catch(() => null);
    let currentBookingId = null;
    let currentBookingEndTime = '';
    let nextBookingStartTime = '';
    let currentBookingDetailsResponse = null;

    if (availabilityStatus === BOOKING_STATUS.BOOKED_UNTIL) {
        currentBookingId = await xapi.Status.Bookings.Current.Id.get().catch(() => null);
        currentBookingEndTime = await xapi.Status.Bookings.Availability.TimeStamp.get().catch(() => '');
        const availabilityEndTimeWasUsable = isFutureTimestamp(currentBookingEndTime);
        if (allowBookingDetailsFallback &&
            (!currentBookingId || !availabilityEndTimeWasUsable)) {
            const fallbackBookingDetails = await readCurrentBookingDetailsFallback(
                currentBookingId,
                bookingGenerationAtStart,
                runtimeStateVersionAtStart
            );
            if (fallbackBookingDetails !== null) {
                currentBookingId = fallbackBookingDetails.bookingId;
                if (!availabilityEndTimeWasUsable) {
                    currentBookingEndTime = fallbackBookingDetails.endTime;
                }
                if (!availabilityEndTimeWasUsable ||
                    getTimestampMs(currentBookingEndTime) === getTimestampMs(fallbackBookingDetails.endTime)) {
                    currentBookingDetailsResponse = fallbackBookingDetails.response;
                }
            }
        }
    } else if (allowBookingDetailsFallback &&
        !Object.values(BOOKING_STATUS).includes(availabilityStatus)) {
        const fallbackBookingDetails = await readCurrentBookingDetailsFallback(
            null,
            bookingGenerationAtStart,
            runtimeStateVersionAtStart
        );
        if (fallbackBookingDetails !== null) {
            availabilityStatus = BOOKING_STATUS.BOOKED_UNTIL;
            currentBookingId = fallbackBookingDetails.bookingId;
            currentBookingEndTime = fallbackBookingDetails.endTime;
            currentBookingDetailsResponse = fallbackBookingDetails.response;
        }
    } else if (availabilityStatus === BOOKING_STATUS.FREE_UNTIL) {
        nextBookingStartTime = await xapi.Status.Bookings.Availability.TimeStamp.get().catch(() => '');
    }

    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameStatusEventVersion(runtimeStateVersionAtStart)) {
        logger.warn(
            LOG_EVENT.STALE_STATE,
            '[BookingAutoCancellation] Ignoring booking snapshot read after the booking state changed.'
        );
        return null;
    }

    return {
        availabilityStatus,
        currentBookingId,
        currentBookingEndTime,
        nextBookingStartTime,
        currentBookingDetailsResponse
    };
}

async function readCurrentBookingDetailsFallback(
    currentBookingId,
    bookingGenerationAtStart,
    runtimeStateVersionAtStart
) {
    let response;
    let booking;
    try {
        if (currentBookingId) {
            response = await xapi.Command.Bookings.Get({ Id: currentBookingId });
            booking = response && response.Booking;
        } else {
            response = await xapi.Command.Bookings.List({
                ScheduleType: 'Current',
                Limit: 1
            });
            const bookings = Array.isArray(response && response.Booking) ?
                response.Booking :
                response && response.Booking ? [response.Booking] : [];
            booking = bookings.length === 1 ? bookings[0] : null;
            response = booking ? { Booking: booking } : null;
        }
    } catch (error) {
        return null;
    }

    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameStatusEventVersion(runtimeStateVersionAtStart)) {
        logger.warn(
            LOG_EVENT.STALE_STATE,
            '[BookingAutoCancellation] Ignoring booking details fallback after the booking state changed.'
        );
        return null;
    }

    const bookingSchedule = getBookingDetailsSchedule(
        response,
        currentBookingId || booking && booking.Id
    );
    if (!booking ||
        !bookingSchedule ||
        bookingSchedule.endTimeMs <= Date.now()) {
        return null;
    }

    return {
        bookingId: booking.Id,
        endTime: bookingSchedule.endTime,
        response
    };
}

function isFutureTimestamp(timestamp) {
    const time = new Date(timestamp).getTime();
    return Number.isFinite(time) && time > Date.now();
}

// ------------------------------------------------------------------------------------------------------------
// -------------------------- 06. Autocancellation Policy ---------------------------------------------------
// ------------------------------------------------------------------------------------------------------------

function resetAutocancellationStatus() {
    bookingLifecycle.autocancellation.status = {
        status: AUTOCANCELLATION_STATUS.BLOCKED,
        blockReason: AUTOCANCELLATION_BLOCK_REASON.NO_CURRENT_BOOKING,
        bookingId: null,
        endTimestamp: '',
        desiredNativeCheckInEnabled: null,
        nativeCheckInSettingApplied: false
    };
}

function getDesiredNativeCheckInEnabled(autocancellationStatus, blockReason) {
    if (autocancellationStatus === AUTOCANCELLATION_STATUS.ALLOWED) {
        return true;
    }
    if (blockReason === AUTOCANCELLATION_BLOCK_REASON.VERIFYING_MEETING_LENGTH) {
        return null;
    }
    return false;
}

function createAutocancellationPolicyDecision(status, blockReason = null) {
    return {
        status,
        blockReason,
        desiredNativeCheckInEnabled: getDesiredNativeCheckInEnabled(status, blockReason)
    };
}

function decideAutocancellationPolicy({
    environmentReady,
    environmentBlockReason,
    hasValidLongMeetingConfiguration,
    currentBookingActive,
    currentBookingId,
    currentBookingEndTime,
    awaitingStartupCheckIn,
    meetingLengthClassification
}) {
    if (!hasValidLongMeetingConfiguration) {
        return createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            AUTOCANCELLATION_BLOCK_REASON.INVALID_LONG_MEETING_EXEMPTION_CONFIGURATION
        );
    }

    if (!environmentReady) {
        return createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            environmentBlockReason
        );
    }

    if (!currentBookingActive ||
        !currentBookingId ||
        getTimestampMs(currentBookingEndTime) === null) {
        return createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            AUTOCANCELLATION_BLOCK_REASON.COULD_NOT_VERIFY_CURRENT_BOOKING
        );
    }

    if (meetingLengthClassification === MEETING_LENGTH_CLASSIFICATION.PENDING) {
        return createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            AUTOCANCELLATION_BLOCK_REASON.VERIFYING_MEETING_LENGTH
        );
    }

    if (meetingLengthClassification === MEETING_LENGTH_CLASSIFICATION.LONG) {
        return createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            AUTOCANCELLATION_BLOCK_REASON.LONG_MEETING
        );
    }

    if (meetingLengthClassification === MEETING_LENGTH_CLASSIFICATION.UNCLASSIFIABLE) {
        return createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            AUTOCANCELLATION_BLOCK_REASON.COULD_NOT_VERIFY_CURRENT_BOOKING
        );
    }

    return createAutocancellationPolicyDecision(
        awaitingStartupCheckIn ? AUTOCANCELLATION_STATUS.BLOCKED : AUTOCANCELLATION_STATUS.ALLOWED,
        awaitingStartupCheckIn ? AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN : null
    );
}

function classifyCurrentBookingDetails(
    response,
    expectedBookingId,
    expectedCurrentBookingEndTime,
    longMeetingExemptionThreshold
) {
    const booking = response && response.Booking;
    const bookingTime = booking && booking.Time;
    const bookingSchedule = getBookingDetailsSchedule(response, expectedBookingId);
    const availabilityEndTimeMs = getTimestampMs(expectedCurrentBookingEndTime);
    if (!bookingSchedule ||
        availabilityEndTimeMs === null ||
        bookingSchedule.endTimeMs !== availabilityEndTimeMs) {
        return {
            classification: MEETING_LENGTH_CLASSIFICATION.UNCLASSIFIABLE,
            failureReason: 'booking_details_invalid',
            failureDetails: `lookup=Bookings.Get responseId=${formatLogValue(booking && booking.Id)} responseStart=${formatLogValue(bookingTime && bookingTime.StartTime)} responseEnd=${formatLogValue(bookingTime && bookingTime.EndTime)} availabilityEnd=${formatLogValue(expectedCurrentBookingEndTime)}`
        };
    }

    const scheduledDuration = bookingSchedule.endTimeMs - bookingSchedule.startTimeMs;
    return {
        classification: scheduledDuration > longMeetingExemptionThreshold ?
            MEETING_LENGTH_CLASSIFICATION.LONG :
            MEETING_LENGTH_CLASSIFICATION.SHORT,
        scheduledDuration
    };
}

function getBookingDetailsSchedule(response, expectedBookingId) {
    const booking = response && response.Booking;
    const bookingTime = booking && booking.Time;
    const scheduledStartTimeMs = getTimestampMs(bookingTime && bookingTime.StartTime);
    const scheduledEndTimeMs = getTimestampMs(bookingTime && bookingTime.EndTime);
    if (!booking ||
        booking.Id !== expectedBookingId ||
        scheduledStartTimeMs === null ||
        scheduledEndTimeMs === null ||
        scheduledEndTimeMs <= scheduledStartTimeMs) {
        return null;
    }
    return {
        startTime: bookingTime.StartTime,
        endTime: bookingTime.EndTime,
        startTimeMs: scheduledStartTimeMs,
        endTimeMs: scheduledEndTimeMs
    };
}

function logAutocancellationPolicyDecision(decision) {
    logger.info(
        LOG_EVENT.READINESS,
        `[BookingAutoCancellation] Autocancellation policy decision: ${decision.status}; reason=${decision.blockReason || 'none'}; nativeCheckIn=${decision.desiredNativeCheckInEnabled === null ? 'unchanged' : decision.desiredNativeCheckInEnabled ? 'enabled' : 'disabled'}; booking=${bookingLifecycle.booking.currentBookingId || '(none)'}`
    );
}

function isCurrentBookingAutocancellationStatus(autocancellationStatus) {
    const currentStatus = bookingLifecycle.autocancellation.status;
    return isCurrentBookingActive() &&
        currentStatus.bookingId === bookingLifecycle.booking.currentBookingId &&
        currentStatus.endTimestamp === bookingLifecycle.booking.currentBookingEndTime &&
        currentStatus.status === autocancellationStatus;
}

function isCurrentBookingAutocancellationBlockedFor(blockReason) {
    const currentStatus = bookingLifecycle.autocancellation.status;
    return isCurrentBookingAutocancellationStatus(AUTOCANCELLATION_STATUS.BLOCKED) &&
        currentStatus.blockReason === blockReason;
}

function isStartupCheckInQuarantineActive() {
    const currentStatus = bookingLifecycle.autocancellation.status;
    return currentStatus.status === AUTOCANCELLATION_STATUS.BLOCKED &&
        currentStatus.blockReason === AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN;
}

function isCurrentBookingAutocancellationAllowed() {
    return isCurrentBookingAutocancellationStatus(AUTOCANCELLATION_STATUS.ALLOWED);
}

function isCurrentBookingAutocancellationBlocked() {
    return isCurrentBookingAutocancellationStatus(AUTOCANCELLATION_STATUS.BLOCKED);
}

function recordCurrentBookingAutocancellationStatus(policyDecision) {
    const previousStatus = bookingLifecycle.autocancellation.status;
    const nativeCheckInSettingApplied = previousStatus.bookingId === bookingLifecycle.booking.currentBookingId &&
        previousStatus.endTimestamp === bookingLifecycle.booking.currentBookingEndTime &&
        previousStatus.desiredNativeCheckInEnabled === policyDecision.desiredNativeCheckInEnabled &&
        previousStatus.nativeCheckInSettingApplied;
    bookingLifecycle.autocancellation.status = {
        status: policyDecision.status,
        blockReason: policyDecision.blockReason,
        bookingId: bookingLifecycle.booking.currentBookingId,
        endTimestamp: bookingLifecycle.booking.currentBookingEndTime,
        desiredNativeCheckInEnabled: policyDecision.desiredNativeCheckInEnabled,
        nativeCheckInSettingApplied
    };
    if (previousStatus.status !== policyDecision.status ||
        previousStatus.blockReason !== policyDecision.blockReason) {
        logAutocancellationPolicyDecision(policyDecision);
    }
    reconcileCurrentBookingReadinessRecovery();
}

function isEnvironmentReadyForAutomation() {
    return bookingLifecycle.presence.isRoomUseStatusSupported &&
        bookingLifecycle.autocancellation.areRequiredConfigurationsHealthy;
}

function getAutocancellationEnvironmentBlockReason() {
    if (!bookingLifecycle.presence.isRoomUseStatusSupported) {
        return AUTOCANCELLATION_BLOCK_REASON.ROOM_USE_STATUS_UNAVAILABLE;
    }
    if (!bookingLifecycle.autocancellation.areRequiredConfigurationsHealthy) {
        return AUTOCANCELLATION_BLOCK_REASON.REQUIRED_CONFIGURATIONS_UNAVAILABLE;
    }
    return AUTOCANCELLATION_BLOCK_REASON.COULD_NOT_VERIFY_CURRENT_BOOKING;
}

function isCurrentBookingAllowedForAutocancellation() {
    return isEnvironmentReadyForAutomation() && isCurrentBookingAutocancellationAllowed();
}

function isCurrentBookingEligibleForAutocancellation() {
    return !isCurrentBookingActive() || isCurrentBookingAllowedForAutocancellation();
}

function isBookingAutomationReady() {
    return isEnvironmentReadyForAutomation() &&
        isCurrentBookingEligibleForAutocancellation();
}

function getRequiredRemainingTimeForReleaseMs() {
    const postTimeoutGracePeriod = CONFIG.DRY_RUN_MODE ? 0 : CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS;
    return CONFIG.EMPTY_ROOM_TIMEOUT_MS + postTimeoutGracePeriod;
}

function getRoomUseCheckPromptDurationMs() {
    const postTimeoutGracePeriod = CONFIG.DRY_RUN_MODE ? 0 : CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS;
    return CONFIG.PRE_TIMEOUT_WARNING_MS + postTimeoutGracePeriod;
}

function isLongMeetingExemptionEnabled() {
    return CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS > 0;
}

function hasValidLongMeetingExemptionConfiguration() {
    return Number.isFinite(CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS) &&
        CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS >= 0;
}

function hasValidNativeCheckInWindowConfiguration() {
    return Number.isFinite(CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES) &&
        CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES > 0 &&
        CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES * 60 * 1000 > getRequiredRemainingTimeForReleaseMs();
}

function getTimestampMs(timestamp) {
    const value = new Date(timestamp).getTime();
    return Number.isFinite(value) ? value : null;
}

function logLongMeetingVerificationFailure(bookingId, reason, details) {
    logger.warn(
        LOG_EVENT.READINESS,
        `[BookingAutoCancellation] Booking ${formatLogValue(bookingId)} could not be classified for the long-meeting exemption. reason=${reason}; ${details}; Booking autocancellation is suspended.`
    );
}

function doesCurrentBookingMatch(currentBookingContext) {
    return isSameBookingLifecycle(currentBookingContext.bookingGeneration) &&
        isSameStatusEventVersion(currentBookingContext.runtimeStateVersion) &&
        bookingLifecycle.booking.currentBookingId === currentBookingContext.bookingId &&
        bookingLifecycle.booking.currentBookingEndTime === currentBookingContext.currentBookingEndTime;
}

function isBookingFreshnessContextStillCurrent(currentBookingContext) {
    return isSameBookingLifecycle(currentBookingContext.bookingGeneration) &&
        isSameStatusEventVersion(currentBookingContext.runtimeStateVersion);
}

// ------------------------------------------------------------------------------------------------------------
// ------------------------------ 07. Native CheckIn ---------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------

// 07.1 Native CheckIn writes
//
// Policy and recovery paths can request opposite native CheckIn values while
// earlier xAPI writes are still pending. Serialize those writes and recheck
// freshness before and after each write so stale work cannot become authoritative.

async function setNativeCheckIn(
    value,
    currentBookingContext = captureCurrentBookingContext()
) {
    if (CONFIG.DRY_RUN_MODE) {
        return true;
    }

    const write = async () => {
        if (!isBookingFreshnessContextStillCurrent(currentBookingContext)) {
            return false;
        }

        try {
            await xapi.Config.Bookings.CheckIn.Enabled.set(value ? 'True' : 'False');
            if (!isBookingFreshnessContextStillCurrent(currentBookingContext)) {
                return false;
            }
            logger.info(
                LOG_EVENT.CONFIGURATION,
                `[BookingAutoCancellation] Enforced Bookings.CheckIn.Enabled: ${value ? 'True' : 'False'}`
            );
            return true;
        } catch (e) {
            if (!isBookingFreshnessContextStillCurrent(currentBookingContext)) {
                return false;
            }
            logger.warn(
                LOG_EVENT.CONFIGURATION,
                `[BookingAutoCancellation] Could not set Bookings.CheckIn.Enabled to ${value ? 'True' : 'False'}:`,
                { setting: 'Bookings.CheckIn.Enabled', value: value ? 'True' : 'False', error: e }
            );
            return false;
        }
    };

    const settingResult = nativeCheckInWriteQueue.then(write, write);
    nativeCheckInWriteQueue = settingResult.catch(() => {});
    return settingResult;
}

// 07.2 Booking policy and guards

async function applyCurrentBookingAutocancellationPolicy(
    policyDecision,
    currentBookingContext = captureCurrentBookingContext()
) {
    if (!doesCurrentBookingMatch(currentBookingContext)) {
        return false;
    }

    recordCurrentBookingAutocancellationStatus(
        policyDecision
    );
    const currentStatus = bookingLifecycle.autocancellation.status;
    if (currentStatus.desiredNativeCheckInEnabled === null || currentStatus.nativeCheckInSettingApplied) {
        return true;
    }

    const nativeCheckInSettingApplied = await setNativeCheckIn(
        currentStatus.desiredNativeCheckInEnabled,
        currentBookingContext
    );
    if (!doesCurrentBookingMatch(currentBookingContext)) {
        return false;
    }
    if (!nativeCheckInSettingApplied) {
        if (policyDecision.status === AUTOCANCELLATION_STATUS.ALLOWED) {
            recordCurrentBookingAutocancellationStatus(
                createAutocancellationPolicyDecision(
                    AUTOCANCELLATION_STATUS.BLOCKED,
                    AUTOCANCELLATION_BLOCK_REASON.NATIVE_CHECK_IN_SETTING_UNAVAILABLE
                )
            );
        }
        return false;
    }

    bookingLifecycle.autocancellation.status.nativeCheckInSettingApplied = true;
    reconcileCurrentBookingReadinessRecovery();
    return true;
}

async function blockCurrentBookingAutocancellation(
    blockReason,
    currentBookingContext = captureCurrentBookingContext()
) {
    if (!isCurrentBookingActive()) {
        return true;
    }
    return applyCurrentBookingAutocancellationPolicy(
        createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            blockReason
        ),
        currentBookingContext
    );
}

async function restoreNativeCheckInWhenNoBooking() {
    return setNativeCheckIn(true);
}

function captureCurrentBookingContext() {
    return {
        bookingGeneration: bookingLifecycle.freshness.bookingGeneration,
        runtimeStateVersion: bookingLifecycle.freshness.runtimeStateVersion,
        bookingId: bookingLifecycle.booking.currentBookingId,
        currentBookingEndTime: bookingLifecycle.booking.currentBookingEndTime
    };
}

function createBookingContextFromValues(
    bookingGeneration,
    runtimeStateVersion,
    bookingId,
    currentBookingEndTime
) {
    return {
        bookingGeneration,
        runtimeStateVersion,
        bookingId,
        currentBookingEndTime
    };
}

function isBookingContextStillCurrent(currentBookingContext) {
    return isSameBookingLifecycle(currentBookingContext.bookingGeneration) &&
        isSameStatusEventVersion(currentBookingContext.runtimeStateVersion) &&
        bookingLifecycle.booking.currentBookingId === currentBookingContext.bookingId &&
        bookingLifecycle.booking.currentBookingEndTime === currentBookingContext.currentBookingEndTime;
}

async function verifyCurrentBookingSchedule(currentBookingContext, verifiedBookingDetailsResponse = null) {
    if (!isBookingContextStillCurrent(currentBookingContext)) {
        return { current: false };
    }
    try {
        const response = verifiedBookingDetailsResponse ||
            await xapi.Command.Bookings.Get({ Id: currentBookingContext.bookingId });
        if (!isBookingContextStillCurrent(currentBookingContext)) {
            return { current: false };
        }

        const classificationResult = classifyCurrentBookingDetails(
            response,
            currentBookingContext.bookingId,
            currentBookingContext.currentBookingEndTime,
            CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS
        );
        if (classificationResult.classification === MEETING_LENGTH_CLASSIFICATION.UNCLASSIFIABLE) {
            bookingLifecycle.booking.currentBookingStartTime = '';
            bookingLifecycle.booking.isBookedFromDevice = false;
            return {
                current: true,
                ...classificationResult
            };
        }
        bookingLifecycle.booking.currentBookingStartTime = response.Booking.Time.StartTime;
        bookingLifecycle.booking.isBookedFromDevice = response.Booking && response.Booking.BookedFromDevice === 'True';
        return {
            current: true,
            ...classificationResult
        };
    } catch (error) {
        if (!isBookingContextStillCurrent(currentBookingContext)) {
            return { current: false };
        }
        bookingLifecycle.booking.currentBookingStartTime = '';
        bookingLifecycle.booking.isBookedFromDevice = false;
        return {
            current: true,
            classification: MEETING_LENGTH_CLASSIFICATION.UNCLASSIFIABLE,
            failureReason: 'bookings_get_error',
            failureDetails: `lookup=Bookings.Get error=${formatLogValue(error.message || error)}`
        };
    }
}

async function evaluateAndApplyCurrentBookingAutocancellationPolicy(
    forceFreshBookingVerification = false,
    verifiedBookingDetailsResponse = null
) {
    const currentBookingContext = captureCurrentBookingContext();
    const bookingGenerationAtStart = currentBookingContext.bookingGeneration;
    const runtimeStateVersionAtStart = currentBookingContext.runtimeStateVersion;
    const bookingIdAtStart = currentBookingContext.bookingId;
    const currentEndTimeAtStart = currentBookingContext.currentBookingEndTime;
    const isAwaitingStartupCheckIn = isCurrentBookingAutocancellationBlockedFor(
        AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
    );
    const canReuseLongMeetingBlock = isCurrentBookingAutocancellationBlockedFor(
        AUTOCANCELLATION_BLOCK_REASON.LONG_MEETING
    ) && bookingLifecycle.autocancellation.status.nativeCheckInSettingApplied;

    // 1. Configuration gate: invalid settings disable automation.
    if (!hasValidLongMeetingExemptionConfiguration()) {
        await applyCurrentBookingAutocancellationPolicy(
            decideAutocancellationPolicy({
                environmentReady: true,
                hasValidLongMeetingConfiguration: false,
                currentBookingActive: isCurrentBookingActive(),
                currentBookingId: bookingIdAtStart,
                currentBookingEndTime: currentEndTimeAtStart,
                meetingLengthClassification: MEETING_LENGTH_CLASSIFICATION.PENDING
            }),
            currentBookingContext
        );
        logger.warn(
            LOG_EVENT.READINESS,
            '[BookingAutoCancellation] LONG_MEETING_EXEMPTION_THRESHOLD_MS is invalid. Booking autocancellation is suspended.'
        );
        return false;
    }

    // 2. Environment gate: unsupported or unhealthy RoomOS inputs fail closed.
    if (!isEnvironmentReadyForAutomation()) {
        await applyCurrentBookingAutocancellationPolicy(
            decideAutocancellationPolicy({
                environmentReady: false,
                environmentBlockReason: getAutocancellationEnvironmentBlockReason(),
                hasValidLongMeetingConfiguration: true,
                currentBookingActive: isCurrentBookingActive(),
                currentBookingId: bookingIdAtStart,
                currentBookingEndTime: currentEndTimeAtStart,
                meetingLengthClassification: MEETING_LENGTH_CLASSIFICATION.PENDING
            }),
            currentBookingContext
        );
        return false;
    }

    // 3. Cached-result gate: reuse only an identity-bound decision.
    if (!forceFreshBookingVerification &&
        (isCurrentBookingAutocancellationAllowed() || canReuseLongMeetingBlock)) {
        return true;
    }
    if (!forceFreshBookingVerification &&
        isCurrentBookingAutocancellationBlocked() &&
        bookingLifecycle.autocancellation.status.nativeCheckInSettingApplied &&
        !isCurrentBookingAutocancellationBlockedFor(
            AUTOCANCELLATION_BLOCK_REASON.NO_CURRENT_BOOKING
        ) &&
        !isCurrentBookingAutocancellationBlockedFor(
            AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
        )) {
        return false;
    }

    // 4. Verification state: keep automation blocked while duration is unknown.
    if (!isAwaitingStartupCheckIn) {
        recordCurrentBookingAutocancellationStatus(
            createAutocancellationPolicyDecision(
                AUTOCANCELLATION_STATUS.BLOCKED,
                AUTOCANCELLATION_BLOCK_REASON.VERIFYING_MEETING_LENGTH
            )
        );
    }
    if (!isCurrentBookingActive() ||
        !bookingIdAtStart ||
        getTimestampMs(currentEndTimeAtStart) === null) {
        if (!isAwaitingStartupCheckIn) {
            await applyCurrentBookingAutocancellationPolicy(
                decideAutocancellationPolicy({
                    environmentReady: true,
                    hasValidLongMeetingConfiguration: true,
                    currentBookingActive: isCurrentBookingActive(),
                    currentBookingId: bookingIdAtStart,
                    currentBookingEndTime: currentEndTimeAtStart,
                    meetingLengthClassification: MEETING_LENGTH_CLASSIFICATION.UNCLASSIFIABLE
                }),
                currentBookingContext
            );
        }
        scheduleBookingReadinessRecovery(currentBookingContext);
        return false;
    }

    if (!isLongMeetingExemptionEnabled()) {
        if (!await applyCurrentBookingAutocancellationPolicy(
            decideAutocancellationPolicy({
                environmentReady: true,
                hasValidLongMeetingConfiguration: true,
                currentBookingActive: true,
                currentBookingId: bookingIdAtStart,
                currentBookingEndTime: currentEndTimeAtStart,
                awaitingStartupCheckIn: isAwaitingStartupCheckIn,
                meetingLengthClassification: MEETING_LENGTH_CLASSIFICATION.SHORT
            }),
            currentBookingContext
        )) {
            return false;
        }
        return true;
    }

    // 5. Booking verification: confirm the current ID and scheduled end time.
    const meetingLengthResult = await verifyCurrentBookingSchedule(
        currentBookingContext,
        verifiedBookingDetailsResponse
    );
    if (!meetingLengthResult.current) {
        scheduleBookingReadinessRecovery(currentBookingContext);
        return false;
    }

    if (meetingLengthResult.classification === MEETING_LENGTH_CLASSIFICATION.UNCLASSIFIABLE) {
        await applyCurrentBookingAutocancellationPolicy(
            decideAutocancellationPolicy({
                environmentReady: true,
                hasValidLongMeetingConfiguration: true,
                currentBookingActive: true,
                currentBookingId: bookingIdAtStart,
                currentBookingEndTime: currentEndTimeAtStart,
                meetingLengthClassification: meetingLengthResult.classification
            }),
            currentBookingContext
        );
        logLongMeetingVerificationFailure(
            bookingIdAtStart,
            meetingLengthResult.failureReason,
            meetingLengthResult.failureDetails
        );
        return false;
    }

    // 6. Policy application: record Allowed or Blocked, then apply native CheckIn.
    const isAwaitingStartupCheckInAfterLookup =
        isCurrentBookingAutocancellationBlockedFor(
            AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
        );
    if (!await applyCurrentBookingAutocancellationPolicy(
        decideAutocancellationPolicy({
            environmentReady: true,
            hasValidLongMeetingConfiguration: true,
            currentBookingActive: true,
            currentBookingId: bookingIdAtStart,
            currentBookingEndTime: currentEndTimeAtStart,
            awaitingStartupCheckIn: isAwaitingStartupCheckInAfterLookup,
            meetingLengthClassification: meetingLengthResult.classification
        }),
        currentBookingContext
    )) {
        return false;
    }
    if (meetingLengthResult.classification === MEETING_LENGTH_CLASSIFICATION.LONG) {
        logger.info(
            LOG_EVENT.READINESS,
            `[BookingAutoCancellation] Booking ${bookingIdAtStart} is blocked from autocancellation: scheduled duration ${meetingLengthResult.scheduledDuration}ms exceeds the ${CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS}ms threshold.`
        );
    }
    return true;
}

function cancelAutomaticCheckIn() {
    if (automaticCheckInTimer !== null) {
        clearTimeout(automaticCheckInTimer);
        automaticCheckInTimer = null;
    }
}

function hasRoomOsCheckedInCurrentBooking() {
    return bookingLifecycle.booking.currentBookingId !== null &&
        bookingLifecycle.checkIn.roomOsCheckedInBookingId === bookingLifecycle.booking.currentBookingId;
}

function hasCheckInConfirmationForCurrentBooking() {
    return bookingLifecycle.booking.currentBookingId !== null &&
        (hasRoomOsCheckedInCurrentBooking() ||
        bookingLifecycle.checkIn.dryRunSimulatedCheckInBookingId === bookingLifecycle.booking.currentBookingId);
}

function getReleasePolicyForCurrentBooking() {
    if (hasCheckInConfirmationForCurrentBooking()) {
        return CONFIG.EARLY_DEPARTURE_RELEASE_ENABLED ? RELEASE_POLICY.EARLY_DEPARTURE : null;
    }
    return RELEASE_POLICY.NO_SHOW;
}

// 07.3 Startup CheckIn

async function quarantineCurrentBookingUntilCheckIn() {
    if (!isCurrentBookingActive() ||
        (isCurrentBookingAutocancellationBlocked() &&
        !isCurrentBookingAutocancellationBlockedFor(
            AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
        ))) {
        return true;
    }

    const bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration;
    const runtimeStateVersionAtStart = bookingLifecycle.freshness.runtimeStateVersion;
    const bookingIdAtStart = bookingLifecycle.booking.currentBookingId;
    const currentEndTimeAtStart = bookingLifecycle.booking.currentBookingEndTime;
    const wasAlreadyAwaitingStartupCheckIn = isCurrentBookingAutocancellationBlockedFor(
        AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
    );
    if (!await applyCurrentBookingAutocancellationPolicy(
        createAutocancellationPolicyDecision(
            AUTOCANCELLATION_STATUS.BLOCKED,
            AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
        ),
        createBookingContextFromValues(
            bookingGenerationAtStart,
            runtimeStateVersionAtStart,
            bookingIdAtStart,
            currentEndTimeAtStart
        )
    )) {
        return false;
    }
    if (wasAlreadyAwaitingStartupCheckIn) {
        return true;
    }
    logger.info(
        LOG_EVENT.CHECKIN,
        `[BookingAutoCancellation] Autocancellation paused: booking ${bookingLifecycle.booking.currentBookingId}; CheckIn state unknown after restart.`
    );
    return true;
}

async function allowCurrentBookingAfterStartupCheckIn() {
    if (!isCurrentBookingAutocancellationBlockedFor(
        AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
    )) {
        return true;
    }

    const bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration;
    const runtimeStateVersionAtStart = bookingLifecycle.freshness.runtimeStateVersion;
    const bookingIdAtStart = bookingLifecycle.booking.currentBookingId;
    const currentEndTimeAtStart = bookingLifecycle.booking.currentBookingEndTime;
    if (!await applyCurrentBookingAutocancellationPolicy(
        createAutocancellationPolicyDecision(AUTOCANCELLATION_STATUS.ALLOWED),
        createBookingContextFromValues(
            bookingGenerationAtStart,
            runtimeStateVersionAtStart,
            bookingIdAtStart,
            currentEndTimeAtStart
        )
    )) {
        return false;
    }
    logger.info(
        LOG_EVENT.CHECKIN,
        `[BookingAutoCancellation] CheckIn confirmed: booking ${bookingLifecycle.booking.currentBookingId}; autocancellation resumed.`
    );
    return true;
}

// ------------------------------------------------------------------------------------------------------------
// --------------------------- 08. Automatic CheckIn ----------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------

function cancelActiveReleaseWorkflow(reason) {
    const hadActiveReleaseWorkflow = bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.IDLE;
    const policy = bookingLifecycle.releaseWorkflow.releasePolicy;
    cancelRoomUseCheckPrompt();
    if (hadActiveReleaseWorkflow && policy !== null) {
        const earlyDepartureState = reason === RELEASE_CANCELLATION_REASON.MATCHING_CHECK_IN ?
            `; earlyDepartureRelease=${CONFIG.EARLY_DEPARTURE_RELEASE_ENABLED ? 'eligible' : 'disabled'}` :
            '';
        logger.info(
            LOG_EVENT.RELEASE_WORKFLOW,
            `[BookingAutoCancellation] ${policy} cancelled: reason=${reason}; booking=${bookingLifecycle.booking.currentBookingId || '(unknown)'}${earlyDepartureState}`
        );
    }
    return hadActiveReleaseWorkflow;
}

function scheduleAutomaticCheckIn() {
    if (!isCurrentBookingActive() ||
        bookingLifecycle.presence.roomUseState !== ROOM_USE_STATE.OCCUPIED ||
        !bookingLifecycle.booking.currentBookingId ||
        !isFutureTimestamp(bookingLifecycle.booking.currentBookingEndTime) ||
        !isBookingAutomationReady() ||
        hasRoomOsCheckedInCurrentBooking() ||
        bookingLifecycle.checkIn.hasAttemptedAutomaticCheckIn ||
        automaticCheckInTimer !== null) {
        return;
    }

    if (bookingLifecycle.booking.isBookedFromDevice) {
        logger.debug(
            LOG_EVENT.CHECKIN,
            `[BookingAutoCancellation] Booking ${bookingLifecycle.booking.currentBookingId} was booked from device; awaiting native RoomOS CheckIn.`
        );
        return;
    }

    const bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration;
    const bookingIdAtStart = bookingLifecycle.booking.currentBookingId;
    automaticCheckInTimer = setTimeout(
        () => automaticallyCheckIn(bookingGenerationAtStart, bookingIdAtStart),
        CONFIG.AUTOMATIC_CHECK_IN_DELAY_MS
    );
    logger.info(
        LOG_EVENT.CHECKIN,
        `[BookingAutoCancellation] Scheduling automatic CheckIn for booking ${bookingIdAtStart} in ${CONFIG.AUTOMATIC_CHECK_IN_DELAY_MS / 1000} seconds.`
    );
}

function isAlreadyCheckedInError(error) {
    return (error && error.message ? error.message : String(error)) ===
        'Cannot check in booking that is already checked in.';
}

async function automaticallyCheckIn(bookingGenerationAtStart, bookingIdAtStart) {
    automaticCheckInTimer = null;
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        bookingLifecycle.booking.currentBookingId !== bookingIdAtStart ||
        bookingLifecycle.presence.roomUseState !== ROOM_USE_STATE.OCCUPIED ||
        !isFutureTimestamp(bookingLifecycle.booking.currentBookingEndTime) ||
        !isBookingAutomationReady() ||
        hasRoomOsCheckedInCurrentBooking() ||
        bookingLifecycle.booking.isBookedFromDevice ||
        bookingLifecycle.checkIn.hasAttemptedAutomaticCheckIn) {
        return;
    }

    const currentBooking = await readCurrentBookingSnapshot(bookingGenerationAtStart);
    if (!currentBooking ||
        currentBooking.availabilityStatus !== BOOKING_STATUS.BOOKED_UNTIL ||
        currentBooking.currentBookingId !== bookingIdAtStart ||
            !isFutureTimestamp(currentBooking.currentBookingEndTime) ||
        bookingLifecycle.presence.roomUseState !== ROOM_USE_STATE.OCCUPIED ||
        hasRoomOsCheckedInCurrentBooking()) {
        return;
    }

    bookingLifecycle.checkIn.hasAttemptedAutomaticCheckIn = true;
    if (CONFIG.DRY_RUN_MODE) {
        logger.info(
            LOG_EVENT.CHECKIN,
            `[BookingAutoCancellation] [DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN] Booking ID ${bookingIdAtStart} would be checked in because the room is occupied.`
        );
        bookingLifecycle.checkIn.dryRunSimulatedCheckInBookingId = bookingIdAtStart;
        logger.info(
            LOG_EVENT.CHECKIN,
            `[BookingAutoCancellation] [DRY RUN - SIMULATED_CHECK_IN] Booking ID ${bookingIdAtStart} is treated as checked in for release-policy simulation.`
        );
        return;
    }

    try {
        logger.info(
            LOG_EVENT.CHECKIN,
            `[BookingAutoCancellation] Automatically checking in occupied booking ${bookingIdAtStart}.`
        );
        await xapi.Command.Bookings.CheckIn({
            Id: bookingIdAtStart,
            TrackingData: 'BookingAutoCancellation_Automatic'
        });
        logger.info(
            LOG_EVENT.CHECKIN,
            `[BookingAutoCancellation] Automatic CheckIn succeeded for booking ${bookingIdAtStart}.`
        );
    } catch (e) {
        if (isAlreadyCheckedInError(e)) {
            logger.info(
                LOG_EVENT.CHECKIN,
                `[BookingAutoCancellation] Automatic CheckIn was not needed for booking ${bookingIdAtStart}: RoomOS reports it is already checked in.`
            );
            return;
        }
        logger.error(
            LOG_EVENT.CHECKIN,
            `[BookingAutoCancellation] Automatic CheckIn failed for booking ${bookingIdAtStart}. Booking release remains available because CheckIn is not a release prerequisite:`,
            { booking: bookingIdAtStart, error: e }
        );
    }
}

// ------------------------------------------------------------------------------------------------------------
// ------------------------------------ 09. Health Checks ------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------

function getDelayUntilCodecLocalMidnightMs(codecTime) {
    if (typeof codecTime !== 'string' || !/[+-]\d{2}:?\d{2}$/.test(codecTime)) {
        return null;
    }

    const currentTime = new Date(codecTime);
    if (!Number.isFinite(currentTime.getTime())) {
        return null;
    }

    const offsetMatch = codecTime.match(/([+-])(\d{2}):?(\d{2})$/);
    const offsetMinutes = (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) *
        (offsetMatch[1] === '+' ? 1 : -1);
    const localTimeMilliseconds = currentTime.getTime() + offsetMinutes * 60 * 1000;
    const localDate = new Date(localTimeMilliseconds);
    const nextLocalMidnight = Date.UTC(
        localDate.getUTCFullYear(),
        localDate.getUTCMonth(),
        localDate.getUTCDate() + 1
    );
    const nextMidnightUtc = nextLocalMidnight - offsetMinutes * 60 * 1000;
    const delay = nextMidnightUtc - Date.now();
    return delay > 0 ? delay : null;
}

function cancelMidnightHealthCheck() {
    if (midnightHealthCheckTimer !== null) {
        clearTimeout(midnightHealthCheckTimer);
        midnightHealthCheckTimer = null;
    }
}

async function scheduleMidnightHealthCheck(codecTime) {
    const delay = getDelayUntilCodecLocalMidnightMs(codecTime);
    if (delay === null) {
        cancelMidnightHealthCheck();
        bookingLifecycle.autocancellation.areRequiredConfigurationsHealthy = false;
        await blockCurrentBookingAutocancellation(
            AUTOCANCELLATION_BLOCK_REASON.CODEC_TIME_UNAVAILABLE
        );
        logger.warn(
            LOG_EVENT.HEALTH_CHECK,
            '[BookingAutoCancellation] Codec local timezone is unavailable or invalid. Midnight health check was not scheduled.'
        );
        return false;
    }

    cancelMidnightHealthCheck();
    midnightHealthCheckTimer = setTimeout(async () => {
        midnightHealthCheckTimer = null;
        const bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration;
        if (!await reconcileAutocancellationReadiness()) {
            cancelRoomUseCheckPrompt();
            logger.warn(
                LOG_EVENT.HEALTH_CHECK,
                '[BookingAutoCancellation] Midnight health check failed; booking autocancellation remains suspended.'
            );
            return;
        }
        if (!isSameBookingLifecycle(bookingGenerationAtStart)) {
            logger.info(
                LOG_EVENT.HEALTH_CHECK,
                '[BookingAutoCancellation] Midnight health check reconciled a newer booking lifecycle.'
            );
        }
        logger.info(
            LOG_EVENT.HEALTH_CHECK,
            '[BookingAutoCancellation] Midnight health check passed.'
        );
        updateReleaseWorkflow();
    }, delay);
    logger.info(
        LOG_EVENT.HEALTH_CHECK,
        `[BookingAutoCancellation] Midnight health check scheduled in ${Math.floor(delay / 1000)} seconds.`
    );
    return true;
}

// ------------------------------------------------------------------------------------------------------------
// ---------------------------------------- 10. Release Workflow ----------------------------------------------
// ------------------------------------------------------------------------------------------------------------

/**
 * Reconciles the current empty-room release attempt with RoomOS state.
 * Unknown presence, unhealthy prerequisites, and short remaining time all
 * cancel or block the workflow instead of authorizing a release.
 */
async function updateReleaseWorkflow() {
    if (bookingLifecycle.presence.roomUseState === ROOM_USE_STATE.UNKNOWN) {
        cancelRoomUseCheckPrompt();
        logger.warn(
            LOG_EVENT.READINESS,
            '[BookingAutoCancellation] RoomInUse state is unknown or unavailable. Booking autocancellation is suspended until presence can be revalidated.',
            { reason: 'presence_state_unknown' }
        );
        return;
    }

    if (!bookingLifecycle.presence.isRoomUseStatusSupported) {
        cancelRoomUseCheckPrompt();
        logger.debug(
            LOG_EVENT.READINESS,
            '[BookingAutoCancellation] Presence readiness is not yet verified; booking autocancellation remains paused while RoomOS state is reconciled.',
            { reason: 'presence_readiness_unverified' }
        );
        return;
    }

    if (!bookingLifecycle.autocancellation.areRequiredConfigurationsHealthy) {
        cancelRoomUseCheckPrompt();
        logger.warn(
            LOG_EVENT.READINESS,
            '[BookingAutoCancellation] Required configuration is not healthy. Booking autocancellation is suspended.'
        );
        return;
    }

    if (isCurrentBookingActive() && !bookingLifecycle.booking.currentBookingId) {
        cancelRoomUseCheckPrompt();
        logger.warn(
            LOG_EVENT.READINESS,
            '[BookingAutoCancellation] Current booking ID is unavailable. Booking autocancellation is suspended.'
        );
        return;
    }

    if (!isBookingAutomationReady()) {
        cancelRoomUseCheckPrompt();
        logger.debug(
            LOG_EVENT.READINESS,
            '[BookingAutoCancellation] Booking autocancellation remains paused for the current booking.',
            {
                booking: bookingLifecycle.booking.currentBookingId,
                reason: bookingLifecycle.autocancellation.status.blockReason
            }
        );
        return;
    }

    if (bookingLifecycle.releaseWorkflow.releasePhase === RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE) {
        return;
    }

    if (isCurrentBookingActive() && bookingLifecycle.presence.roomUseState === ROOM_USE_STATE.EMPTY) {
        const releasePolicy = getReleasePolicyForCurrentBooking();
        if (releasePolicy === null) {
            cancelReleaseTimers();
            return;
        }
        if (bookingLifecycle.booking.currentBookingEndTime) {
            const endTime = new Date(bookingLifecycle.booking.currentBookingEndTime).getTime();
            const timeRemaining = endTime - new Date().getTime();

            if (timeRemaining > getRequiredRemainingTimeForReleaseMs()) {
                startEmptyRoomCountdown(releasePolicy);
            } else {
                cancelReleaseTimers();
                const remainingSeconds = Math.max(0, Math.floor(timeRemaining / 1000));
                const requiredSeconds = Math.ceil(getRequiredRemainingTimeForReleaseMs() / 1000);
                logger.info(
                    LOG_EVENT.RELEASE_WORKFLOW,
                    `[BookingAutoCancellation] Booking autocancellation skipped for booking ${bookingLifecycle.booking.currentBookingId}: ${remainingSeconds}s remaining; requires >${requiredSeconds}s.`
                );
            }
        } else {
            cancelReleaseTimers();
            logger.warn(
                LOG_EVENT.READINESS,
                '[BookingAutoCancellation] Current booking end time is unavailable. Booking autocancellation is suspended.'
            );
        }
        return;
    }

    cancelReleaseTimers();
}

// 10.1 Release eligibility and countdown

/**
 * Starts one release attempt for the current empty booking. The workflow
 * generation makes a canceled countdown callback harmless.
 */
function startEmptyRoomCountdown(releasePolicy) {
    if (bookingLifecycle.releaseWorkflow.releasePhase === RELEASE_WORKFLOW_PHASE.COUNTDOWN_SCHEDULED &&
        bookingLifecycle.releaseWorkflow.releasePolicy === releasePolicy) {
        return;
    }

    if (bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.IDLE) {
        cancelReleaseTimers();
    }

    if (bookingLifecycle.releaseWorkflow.countdownTimer !== null) {
        clearTimeout(bookingLifecycle.releaseWorkflow.countdownTimer);
        bookingLifecycle.releaseWorkflow.countdownTimer = null;
    }

    const promptDelay = CONFIG.EMPTY_ROOM_TIMEOUT_MS - CONFIG.PRE_TIMEOUT_WARNING_MS;
    const promptDuration = getRoomUseCheckPromptDurationMs();
    bookingLifecycle.releaseWorkflow.releasePhase = RELEASE_WORKFLOW_PHASE.COUNTDOWN_SCHEDULED;
    bookingLifecycle.releaseWorkflow.releasePolicy = releasePolicy;
    bookingLifecycle.releaseWorkflow.releaseWorkflowGeneration += 1;
    const releaseWorkflowContext = captureReleaseWorkflowContext();
    logger.info(
        LOG_EVENT.RELEASE_WORKFLOW,
        `[BookingAutoCancellation] ${releasePolicy} started: booking ${bookingLifecycle.booking.currentBookingId}; prompt in ${promptDelay / 1000}s; release validation ${promptDuration / 1000}s later.`
    );
    bookingLifecycle.releaseWorkflow.countdownTimer = setTimeout(
        () => displayRoomUseCheckPrompt(releaseWorkflowContext),
        promptDelay
    );
}

// 10.2 Release timers

function captureReleaseWorkflowContext() {
    return {
        bookingGeneration: bookingLifecycle.freshness.bookingGeneration,
        releaseWorkflowGeneration: bookingLifecycle.releaseWorkflow.releaseWorkflowGeneration
    };
}

function isCurrentReleaseWorkflowContext(releaseWorkflowContext) {
    return isSameBookingLifecycle(releaseWorkflowContext.bookingGeneration) &&
        isSameReleaseWorkflow(releaseWorkflowContext.releaseWorkflowGeneration);
}

/**
 * Invalidates internal release timers and prompt ownership. External prompt
 * cleanup is handled separately by cancelRoomUseCheckPrompt().
 */
function cancelReleaseTimers() {
    bookingLifecycle.releaseWorkflow.releaseWorkflowGeneration += 1;
    if (bookingLifecycle.releaseWorkflow.countdownTimer !== null) {
        clearTimeout(bookingLifecycle.releaseWorkflow.countdownTimer);
        bookingLifecycle.releaseWorkflow.countdownTimer = null;
    }
    if (bookingLifecycle.releaseWorkflow.promptExpiryTimer !== null) {
        clearTimeout(bookingLifecycle.releaseWorkflow.promptExpiryTimer);
        bookingLifecycle.releaseWorkflow.promptExpiryTimer = null;
    }
    if (bookingLifecycle.releaseWorkflow.promptAlertIntervalTimer !== null) {
        clearInterval(bookingLifecycle.releaseWorkflow.promptAlertIntervalTimer);
        bookingLifecycle.releaseWorkflow.promptAlertIntervalTimer = null;
    }
    restoreRoomUseCheckPromptVolume();
    bookingLifecycle.releaseWorkflow.promptExpiresAt = null;
    bookingLifecycle.releaseWorkflow.controllerPromptDisplayed = false;
    bookingLifecycle.releaseWorkflow.osdPromptDisplayed = false;
    bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation = false;
    bookingLifecycle.releaseWorkflow.isCheckOutInProgress = false;
    bookingLifecycle.releaseWorkflow.releasePhase = RELEASE_WORKFLOW_PHASE.IDLE;
    bookingLifecycle.releaseWorkflow.releasePolicy = null;
}

// 10.3 Checkout attribution

function markPendingMacroCheckout(bookingId, bookingGeneration, bookingEndTime) {
    bookingLifecycle.checkout.pendingMacroCheckoutBookingId = bookingId;
    bookingLifecycle.checkout.pendingMacroCheckoutBookingGeneration = bookingGeneration;
    bookingLifecycle.checkout.pendingMacroCheckoutEndTime = bookingEndTime;
}

function clearPendingMacroCheckout(bookingId = null, bookingGeneration = null) {
    if ((bookingId !== null &&
        bookingLifecycle.checkout.pendingMacroCheckoutBookingId !== bookingId) ||
        (bookingGeneration !== null &&
        bookingLifecycle.checkout.pendingMacroCheckoutBookingGeneration !== bookingGeneration)) {
        return;
    }
    bookingLifecycle.checkout.pendingMacroCheckoutBookingId = null;
    bookingLifecycle.checkout.pendingMacroCheckoutBookingGeneration = null;
    bookingLifecycle.checkout.pendingMacroCheckoutEndTime = '';
}

function consumePendingMacroCheckout(bookingId, bookingEndTime) {
    if (bookingLifecycle.checkout.pendingMacroCheckoutBookingGeneration !==
        bookingLifecycle.freshness.bookingGeneration ||
        bookingLifecycle.checkout.pendingMacroCheckoutBookingId !== bookingId ||
        bookingLifecycle.checkout.pendingMacroCheckoutEndTime !== bookingEndTime) {
        return false;
    }
    clearPendingMacroCheckout();
    return true;
}

// ------------------------------------------------------------------------------------------------------------
// ----------------------------------------- 11. Prompt Surfaces ----------------------------------------------
// ------------------------------------------------------------------------------------------------------------

function clearRoomUseCheckPrompts(prompts) {
    if (CONFIG.DRY_RUN_MODE) {
        return;
    }

    prompts.forEach(prompt => {
        xapi.Command.UserInterface.Message.Prompt.Clear(prompt).catch(e => {
            logger.warn(
                LOG_EVENT.PROMPT,
                `[BookingAutoCancellation] ${prompt.Target} room use check prompt could not be cleared:`,
                { target: prompt.Target, feedbackId: prompt.FeedbackId, error: e }
            );
        });
    });
}

function clearRoomUseCheckWarningPrompts() {
    clearRoomUseCheckPrompts([
        { Target: 'Controller', FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER },
        { Target: 'OSD', FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_OSD }
    ]);
}

function clearRoomUseCheckPrompt() {
    clearRoomUseCheckPrompts([
        { Target: 'Controller', FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER },
        { Target: 'Controller', FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_CONTROLLER },
        { Target: 'OSD', FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_OSD },
        { Target: 'OSD', FeedbackId: ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_OSD }
    ]);
}

function cancelRoomUseCheckPrompt() {
    cancelReleaseTimers();
    clearRoomUseCheckPrompt();
}

function restoreRoomUseCheckPromptVolume() {
    if (!bookingLifecycle.releaseWorkflow.isPromptAlertVolumeOverridden) {
        return;
    }

    if (bookingLifecycle.releaseWorkflow.promptAlertVolumeRestoreTimer !== null) {
        clearTimeout(bookingLifecycle.releaseWorkflow.promptAlertVolumeRestoreTimer);
        bookingLifecycle.releaseWorkflow.promptAlertVolumeRestoreTimer = null;
    }
    bookingLifecycle.releaseWorkflow.isPromptAlertVolumeOverridden = false;
    xapi.Command.Audio.Volume.SetToDefault().catch(e => {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Audio volume could not be restored to its default after the room use check prompt sound:',
            { error: e }
        );
    });
}

async function playRoomUseCheckPromptSound() {
    if (CONFIG.DRY_RUN_MODE ||
        bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE) {
        return;
    }

    try {
        await xapi.Command.Audio.Volume.Set({ Level: ROOM_USE_CHECK_PROMPT.AUDIO_ALERT.VOLUME_LEVEL });
        bookingLifecycle.releaseWorkflow.isPromptAlertVolumeOverridden = true;
        await xapi.Command.Audio.Sound.Play({ Loop: 'Off', Sound: ROOM_USE_CHECK_PROMPT.AUDIO_ALERT.SOUND });
        if (bookingLifecycle.releaseWorkflow.promptAlertVolumeRestoreTimer !== null) {
            clearTimeout(bookingLifecycle.releaseWorkflow.promptAlertVolumeRestoreTimer);
        }
        bookingLifecycle.releaseWorkflow.promptAlertVolumeRestoreTimer = setTimeout(
            restoreRoomUseCheckPromptVolume,
            ROOM_USE_CHECK_PROMPT.AUDIO_ALERT.VOLUME_HOLD_MS
        );
    } catch (e) {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Room use check prompt sound could not be played:',
            { error: e }
        );
        restoreRoomUseCheckPromptVolume();
    }
}

// 11.1 Prompt display and ownership

async function displayControllerRoomUseCheckPrompt(bookingGenerationAtStart, releaseWorkflowGenerationAtStart, remainingSeconds) {
    if (CONFIG.DRY_RUN_MODE) {
        return;
    }

    const isConfirming = bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation;
    const feedbackId = isConfirming ?
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_CONTROLLER :
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER;
    const title = isConfirming ?
        ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.TITLE :
        ROOM_USE_CHECK_PROMPT.WARNING.TITLE;
    const text = isConfirming ?
        ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.CONTROLLER_TEXT :
        (bookingLifecycle.releaseWorkflow.hasUserSelectedKeepBooking ?
            ROOM_USE_CHECK_PROMPT.WARNING.REPEATED.CONTROLLER_TEXT :
            ROOM_USE_CHECK_PROMPT.WARNING.INITIAL.CONTROLLER_TEXT);
    const optionOneLabel = isConfirming ?
        ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.OPTIONS.CANCEL.LABEL :
        ROOM_USE_CHECK_PROMPT.OPTIONS.KEEP_BOOKING.LABEL;
    const optionTwoLabel = isConfirming ?
        ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.OPTIONS.CHECK_OUT.LABEL :
        ROOM_USE_CHECK_PROMPT.OPTIONS.CHECK_OUT.LABEL;

    try {
        await xapi.Command.UserInterface.Message.Prompt.Display({
            Target: 'Controller',
            Title: title,
            Text: text,
            FeedbackId: feedbackId,
            Duration: remainingSeconds,
            'Option.1': optionOneLabel,
            'Option.2': optionTwoLabel
        });
        if (isSameBookingLifecycle(bookingGenerationAtStart) &&
            isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) &&
            hasControllerRoomUseCheckPromptSurface()) {
            bookingLifecycle.releaseWorkflow.controllerPromptDisplayed = true;
            logger.info(
                LOG_EVENT.PROMPT,
                `[BookingAutoCancellation] Controller room use check prompt displayed with ${remainingSeconds} seconds remaining.`
            );
        } else {
            logger.warn(
                LOG_EVENT.PROMPT,
                '[BookingAutoCancellation] Clearing controller room use check prompt because its workflow was cancelled or controller availability changed while the prompt was displaying.'
            );
            try {
                if (!CONFIG.DRY_RUN_MODE) {
                    await xapi.Command.UserInterface.Message.Prompt.Clear({
                        Target: 'Controller',
                        FeedbackId: feedbackId
                    });
                }
                if (bookingLifecycle.releaseWorkflow.releasePhase === RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE &&
                    bookingLifecycle.releaseWorkflow.controllerPromptDisplayed) {
                    bookingLifecycle.releaseWorkflow.controllerPromptDisplayed = false;
                    await refreshRoomUseCheckPromptPresentation();
                }
            } catch (e) {
                logger.warn(
                    LOG_EVENT.PROMPT,
                    '[BookingAutoCancellation] Controller room use check prompt could not be cleared after a delayed display:',
                    { target: 'Controller', error: e }
                );
            }
        }
    } catch (e) {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Controller room use check prompt could not be displayed:',
            { target: 'Controller', error: e }
        );
    }
}

async function displayOsdRoomUseCheckPrompt(bookingGenerationAtStart, releaseWorkflowGenerationAtStart, remainingSeconds) {
    if (CONFIG.DRY_RUN_MODE) {
        return;
    }

    const isConfirming = bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation;
    const feedbackId = isConfirming ?
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_OSD :
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_OSD;
    let title = ROOM_USE_CHECK_PROMPT.WARNING.TITLE;
    let text = '';

    if (canUseInteractiveOsd()) {
        title = isConfirming ?
            ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.TITLE :
            ROOM_USE_CHECK_PROMPT.WARNING.TITLE;
        text = isConfirming ?
            ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.CONTROLLER_TEXT :
            (bookingLifecycle.releaseWorkflow.hasUserSelectedKeepBooking ?
                ROOM_USE_CHECK_PROMPT.WARNING.REPEATED.CONTROLLER_TEXT :
                ROOM_USE_CHECK_PROMPT.WARNING.INITIAL.CONTROLLER_TEXT);
    } else {
        title = isConfirming ?
            ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.TITLE :
            ROOM_USE_CHECK_PROMPT.WARNING.TITLE;
        text = isConfirming ?
            ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.OSD_TEXT :
            (bookingLifecycle.releaseWorkflow.hasUserSelectedKeepBooking ?
                ROOM_USE_CHECK_PROMPT.WARNING.REPEATED.OSD_TEXT :
                ROOM_USE_CHECK_PROMPT.WARNING.INITIAL.OSD_TEXT);
    }
    const optionOneLabel = isConfirming ?
        ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.OPTIONS.CANCEL.LABEL :
        ROOM_USE_CHECK_PROMPT.OPTIONS.KEEP_BOOKING.LABEL;
    const optionTwoLabel = isConfirming ?
        ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.OPTIONS.CHECK_OUT.LABEL :
        ROOM_USE_CHECK_PROMPT.OPTIONS.CHECK_OUT.LABEL;

    const prompt = {
        Target: 'OSD',
        Title: title,
        Text: text,
        FeedbackId: feedbackId,
        Duration: remainingSeconds
    };
    if (canUseInteractiveOsd()) {
        prompt['Option.1'] = optionOneLabel;
        prompt['Option.2'] = optionTwoLabel;
    }

    try {
        await xapi.Command.UserInterface.Message.Prompt.Display(prompt);
        if (isSameBookingLifecycle(bookingGenerationAtStart) &&
            isSameReleaseWorkflow(releaseWorkflowGenerationAtStart)) {
            bookingLifecycle.releaseWorkflow.osdPromptDisplayed = true;
            logger.info(
                LOG_EVENT.PROMPT,
                `[BookingAutoCancellation] OSD room use check prompt displayed with ${remainingSeconds} seconds remaining.`
            );
        } else {
            logger.warn(
                LOG_EVENT.PROMPT,
                '[BookingAutoCancellation] Clearing OSD room use check prompt because its workflow was cancelled while the prompt was displaying.'
            );
            try {
                if (!CONFIG.DRY_RUN_MODE) {
                    await xapi.Command.UserInterface.Message.Prompt.Clear({
                        Target: 'OSD',
                        FeedbackId: feedbackId
                    });
                }
                if (bookingLifecycle.releaseWorkflow.releasePhase === RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE &&
                    bookingLifecycle.releaseWorkflow.osdPromptDisplayed) {
                    bookingLifecycle.releaseWorkflow.osdPromptDisplayed = false;
                    await refreshRoomUseCheckPromptPresentation();
                }
            } catch (e) {
                logger.warn(
                    LOG_EVENT.PROMPT,
                    '[BookingAutoCancellation] OSD room use check prompt could not be cleared after a delayed display:',
                    { target: 'OSD', error: e }
                );
            }
        }
    } catch (e) {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] OSD room use check prompt could not be displayed:',
            { target: 'OSD', error: e }
        );
    }
}

async function refreshRoomUseCheckPromptPresentation(
    bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration,
    releaseWorkflowGenerationAtStart = bookingLifecycle.releaseWorkflow.releaseWorkflowGeneration
) {
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) ||
        bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE) {
        return;
    }

    const remainingSeconds = getRoomUseCheckPromptTimeRemainingSeconds();
    if (remainingSeconds === 0) {
        return;
    }

    if (hasControllerRoomUseCheckPromptSurface() && !bookingLifecycle.releaseWorkflow.controllerPromptDisplayed) {
        await displayControllerRoomUseCheckPrompt(
            bookingGenerationAtStart,
            releaseWorkflowGenerationAtStart,
            remainingSeconds
        );
    }

    if (!bookingLifecycle.releaseWorkflow.osdPromptDisplayed) {
        await displayOsdRoomUseCheckPrompt(
            bookingGenerationAtStart,
            releaseWorkflowGenerationAtStart,
            remainingSeconds
        );
    }
}

// 11.2 Prompt expiry and final validation

// A visible prompt is not automatically an authorization surface. Only a
// controller or verified interactive OSD that can return Stay may authorize
// the later CheckOut; informational OSD output never does.

/**
 * Displays the warning for an empty-room release attempt. Prompt expiry only
 * starts final validation; it never authorizes CheckOut by itself.
 */
async function displayRoomUseCheckPrompt(releaseWorkflowContext) {
    if (!isCurrentReleaseWorkflowContext(releaseWorkflowContext)) {
        return;
    }

    bookingLifecycle.releaseWorkflow.countdownTimer = null;
    bookingLifecycle.releaseWorkflow.releasePhase = RELEASE_WORKFLOW_PHASE.PROMPT_PENDING;
    logger.info(
        LOG_EVENT.RELEASE_WORKFLOW,
        `[BookingAutoCancellation] Empty-room countdown expired for booking ${bookingLifecycle.booking.currentBookingId || '(unknown)'} in booking generation ${releaseWorkflowContext.bookingGeneration}. Preparing room use check prompt.`
    );
    if (CONFIG.DRY_RUN_MODE) {
        logger.info(
            LOG_EVENT.PROMPT,
            `[BookingAutoCancellation] [DRY RUN - WOULD_DISPLAY_PROMPT] Booking ID ${bookingLifecycle.booking.currentBookingId || '(unknown)'} would display the room use check prompt now.`
        );
        bookingLifecycle.releaseWorkflow.promptExpiryTimer = setTimeout(
            () => releaseBookingAfterPromptExpires(releaseWorkflowContext.bookingGeneration, releaseWorkflowContext.releaseWorkflowGeneration),
            getRoomUseCheckPromptDurationMs()
        );
        return;
    }

    bookingLifecycle.releaseWorkflow.releasePhase = RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE;
    const promptDuration = getRoomUseCheckPromptDurationMs();
    bookingLifecycle.releaseWorkflow.promptExpiresAt = Date.now() + promptDuration;
    bookingLifecycle.releaseWorkflow.promptExpiryTimer = setTimeout(
        () => releaseBookingAfterPromptExpires(releaseWorkflowContext.bookingGeneration, releaseWorkflowContext.releaseWorkflowGeneration),
        promptDuration
    );
    if (bookingLifecycle.releaseWorkflow.promptAlertIntervalTimer !== null) {
        clearInterval(bookingLifecycle.releaseWorkflow.promptAlertIntervalTimer);
    }
    bookingLifecycle.releaseWorkflow.promptAlertIntervalTimer = setInterval(
        () => playRoomUseCheckPromptSound(),
        ROOM_USE_CHECK_PROMPT.AUDIO_ALERT.REPEAT_INTERVAL_MS
    );
    await refreshRoomUseCheckPromptPresentation(
        releaseWorkflowContext.bookingGeneration,
        releaseWorkflowContext.releaseWorkflowGeneration
    );
    if (!isCurrentReleaseWorkflowContext(releaseWorkflowContext)) {
        return;
    }
    if (!hasActionableRoomUseCheckPromptOwnership()) {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Room use check prompt is visible, but no actionable Stay surface is currently available. Release will be blocked unless one becomes available before expiry.'
        );
    }
    await playRoomUseCheckPromptSound();
}

async function validateReleaseBeforeCheckOut(bookingGenerationAtStart, releaseWorkflowGenerationAtStart) {
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart)) {
        return { valid: false, reason: 'stale_release_workflow' };
    }

    if (bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation) {
        cancelReleaseTimers();
        clearRoomUseCheckPrompt();
        return { valid: false, reason: 'unconfirmed_user_checkout_guard' };
    }

    if (!bookingLifecycle.presence.isRoomUseStatusSupported) {
        return { valid: false, reason: 'presence_unsupported' };
    }

    if (!isBookingAutomationReady()) {
        return { valid: false, reason: 'autocancellation_not_ready' };
    }

    if (bookingLifecycle.presence.roomUseState !== ROOM_USE_STATE.EMPTY) {
        cancelRoomUseCheckPrompt();
        return { valid: false, reason: 'room_not_confirmed_empty' };
    }

    const promptSuppressedForDryRun = CONFIG.DRY_RUN_MODE;
    if (!promptSuppressedForDryRun) {
        await refreshControllerRoomUseCheckPromptSurface();
        if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
            !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart)) {
            return { valid: false, reason: 'stale_release_workflow' };
        }
    }
    if (!promptSuppressedForDryRun && !hasActionableRoomUseCheckPromptOwnership()) {
        cancelReleaseTimers();
        clearRoomUseCheckPrompt();
        return { valid: false, reason: 'no_actionable_prompt_surface' };
    }

    const currentBooking = await readCurrentBookingSnapshot(bookingGenerationAtStart);
    if (!isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) ||
        !currentBooking ||
        currentBooking.availabilityStatus !== BOOKING_STATUS.BOOKED_UNTIL ||
        !currentBooking.currentBookingId ||
        currentBooking.currentBookingId !== bookingLifecycle.booking.currentBookingId ||
        !isFutureTimestamp(currentBooking.currentBookingEndTime)) {
        cancelReleaseTimers();
        clearRoomUseCheckPrompt();
        return { valid: false, reason: 'current_booking_snapshot_invalid' };
    }

    if (!await evaluateAndApplyCurrentBookingAutocancellationPolicy(true) ||
        !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) ||
        !isBookingAutomationReady()) {
        cancelReleaseTimers();
        clearRoomUseCheckPrompt();
        return { valid: false, reason: 'current_booking_policy_invalid' };
    }

    logger.info(
        LOG_EVENT.RELEASE_WORKFLOW,
        '[BookingAutoCancellation] Release validation passed before CheckOut.'
    );
    return { valid: true, currentBooking };
}

// CheckOut is the irreversible booking-changing effect, so callers must pass
// through validateReleaseBeforeCheckOut() immediately before reaching it.
function getCheckoutReason(releasePolicy) {
    return releasePolicy === RELEASE_POLICY.EARLY_DEPARTURE ? 'early_departure' : 'no_show';
}

async function checkoutValidatedCurrentBooking(currentBooking, bookingGenerationAtStart, releaseWorkflowGenerationAtStart) {
    const checkoutReason = getCheckoutReason(bookingLifecycle.releaseWorkflow.releasePolicy);
    if (CONFIG.DRY_RUN_MODE) {
        logger.info(
            LOG_EVENT.CHECKOUT,
            `[BookingAutoCancellation] [DRY RUN - WOULD_RELEASE] Booking ID ${bookingLifecycle.booking.currentBookingId} would be checked out now due to inactivity.`,
            {
                source: 'macro',
                mode: 'dry_run',
                outcome: 'would_issue',
                booking: bookingLifecycle.booking.currentBookingId,
                reason: checkoutReason
            }
        );
        cancelRoomUseCheckPrompt();
        return true;
    }

    const bookingIdAtCheckOut = currentBooking.currentBookingId;
    markPendingMacroCheckout(
        bookingIdAtCheckOut,
        bookingGenerationAtStart,
        currentBooking.currentBookingEndTime
    );
    try {
        await xapi.Command.Bookings.CheckOut({ Id: bookingIdAtCheckOut });
    } catch (e) {
        clearPendingMacroCheckout(bookingIdAtCheckOut, bookingGenerationAtStart);
        throw e;
    }
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        bookingLifecycle.booking.currentBookingId !== currentBooking.currentBookingId) {
        logger.warn(
            LOG_EVENT.CHECKOUT,
            '[BookingAutoCancellation] Ignoring CheckOut completion after the booking changed.',
            {
                source: 'macro',
                mode: 'live',
                outcome: 'ignored',
                booking: currentBooking.currentBookingId
            }
        );
        clearPendingMacroCheckout(bookingIdAtCheckOut, bookingGenerationAtStart);
        return false;
    }
    logger.info(
        LOG_EVENT.CHECKOUT,
        `[BookingAutoCancellation] Booking ${currentBooking.currentBookingId} checked out and freed successfully.`,
        {
            source: 'macro',
            mode: 'live',
            outcome: 'issued',
            booking: currentBooking.currentBookingId,
            reason: checkoutReason
        }
    );
    clearRoomUseCheckPrompt();
    cancelReleaseTimers();
    return true;
}

async function checkoutCurrentBookingOnUserConfirmation(bookingGenerationAtStart, releaseWorkflowGenerationAtStart) {
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart)) {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Ignoring confirmed Check Out because the booking or release workflow changed.'
        );
        return;
    }

    const currentBooking = await readCurrentBookingSnapshot(bookingGenerationAtStart);
    if (!isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) ||
        !currentBooking ||
        currentBooking.availabilityStatus !== BOOKING_STATUS.BOOKED_UNTIL ||
        !currentBooking.currentBookingId ||
        currentBooking.currentBookingId !== bookingLifecycle.booking.currentBookingId) {
        cancelRoomUseCheckPrompt();
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Ignoring confirmed Check Out because the booking snapshot is no longer valid.'
        );
        return;
    }

    const bookingIdAtCheckOut = currentBooking.currentBookingId;
    if (CONFIG.DRY_RUN_MODE) {
        logger.info(
            LOG_EVENT.CHECKOUT,
            `[BookingAutoCancellation] [DRY RUN - WOULD_RELEASE] Booking ID ${bookingIdAtCheckOut} would be checked out now due to user confirmation.`,
            {
                source: 'macro',
                mode: 'dry_run',
                outcome: 'would_issue',
                booking: bookingIdAtCheckOut,
                reason: 'user_confirmed'
            }
        );
        cancelRoomUseCheckPrompt();
        return;
    }

    try {
        markPendingMacroCheckout(
            bookingIdAtCheckOut,
            bookingGenerationAtStart,
            currentBooking.currentBookingEndTime
        );
        await xapi.Command.Bookings.CheckOut({ Id: bookingIdAtCheckOut });
        if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
            bookingLifecycle.booking.currentBookingId !== currentBooking.currentBookingId) {
            logger.warn(
                LOG_EVENT.CHECKOUT,
                '[BookingAutoCancellation] Ignoring CheckOut completion after the booking changed.',
                {
                    source: 'macro',
                    mode: 'live',
                    outcome: 'ignored',
                    booking: currentBooking.currentBookingId
                }
            );
            clearPendingMacroCheckout(bookingIdAtCheckOut, bookingGenerationAtStart);
            return;
        }
        logger.info(
            LOG_EVENT.CHECKOUT,
            `[BookingAutoCancellation] Booking ${currentBooking.currentBookingId} checked out and freed successfully.`,
            {
                source: 'macro',
                mode: 'live',
                outcome: 'issued',
                booking: currentBooking.currentBookingId,
                reason: 'user_confirmed'
            }
        );
        clearRoomUseCheckPrompt();
        cancelReleaseTimers();
    } catch (e) {
        clearPendingMacroCheckout(bookingIdAtCheckOut, bookingGenerationAtStart);
        if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
            !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) ||
            bookingLifecycle.booking.currentBookingId !== bookingIdAtCheckOut) {
            logger.warn(
                LOG_EVENT.CHECKOUT,
                '[BookingAutoCancellation] Ignoring user CheckOut failure after the booking changed.',
                {
                    source: 'macro',
                    mode: 'live',
                    outcome: 'ignored',
                    booking: bookingIdAtCheckOut,
                    error: e
                }
            );
            return;
        }
        await blockCurrentBookingAutocancellation(
            AUTOCANCELLATION_BLOCK_REASON.CHECK_OUT_FAILED
        );
        logger.error(
            LOG_EVENT.CHECKOUT,
            '[BookingAutoCancellation] Checkout failed or not permitted on this meeting. Booking release aborted for safety.',
            {
                source: 'macro',
                mode: 'live',
                outcome: 'failed',
                booking: bookingIdAtCheckOut,
                reason: 'user_confirmed',
                error: e
            }
        );
        cancelReleaseTimers();
        clearRoomUseCheckPrompt();
    }
}

/**
 * Handles prompt expiry. It validates the current booking and every release
 * prerequisite again before sending CheckOut; expiry alone never authorizes it.
 */
async function releaseBookingAfterPromptExpires(bookingGenerationAtStart, releaseWorkflowGenerationAtStart) {
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart)) {
        return;
    }

    bookingLifecycle.releaseWorkflow.promptExpiryTimer = null;
    logger.info(
        LOG_EVENT.RELEASE_WORKFLOW,
        `[BookingAutoCancellation] Room use check prompt expired for booking ${bookingLifecycle.booking.currentBookingId || '(unknown)'} in booking generation ${bookingGenerationAtStart}. Validating release.`
    );

    let bookingIdAtCheckOut = null;
    try {
        const releaseValidation = await validateReleaseBeforeCheckOut(
            bookingGenerationAtStart,
            releaseWorkflowGenerationAtStart
        );
        if (!releaseValidation.valid) {
            logger.warn(
                LOG_EVENT.RELEASE_WORKFLOW,
                `[BookingAutoCancellation] Aborting booking release: validation=${releaseValidation.reason}.`,
                { reason: releaseValidation.reason }
            );
            if (releaseValidation.reason === 'unconfirmed_user_checkout_guard') {
                logger.info(
                    LOG_EVENT.RELEASE_WORKFLOW,
                    '[BookingAutoCancellation] Check Out was not confirmed. Preserving the booking and revalidating room use before restoring the room use check prompt.'
                );
                await reconcileRoomUseAfterManualReleaseCancellation('an unconfirmed Check Out');
                if (bookingLifecycle.presence.roomUseState === ROOM_USE_STATE.EMPTY &&
                    bookingLifecycle.releaseWorkflow.releasePhase === RELEASE_WORKFLOW_PHASE.COUNTDOWN_SCHEDULED) {
                    clearTimeout(bookingLifecycle.releaseWorkflow.countdownTimer);
                    bookingLifecycle.releaseWorkflow.countdownTimer = null;
                    await displayRoomUseCheckPrompt(captureReleaseWorkflowContext());
                }
                return;
            }
            if (bookingLifecycle.presence.roomUseState === ROOM_USE_STATE.OCCUPIED) {
                scheduleAutomaticCheckIn();
            }
            return;
        }
        const currentBooking = releaseValidation.currentBooking;
        bookingIdAtCheckOut = currentBooking.currentBookingId;

        await checkoutValidatedCurrentBooking(
            currentBooking,
            bookingGenerationAtStart,
            releaseWorkflowGenerationAtStart
        );
    } catch (e) {
        if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
            !isSameReleaseWorkflow(releaseWorkflowGenerationAtStart) ||
            bookingLifecycle.booking.currentBookingId !== bookingIdAtCheckOut) {
            logger.warn(
                LOG_EVENT.CHECKOUT,
                '[BookingAutoCancellation] Ignoring CheckOut failure after the booking changed.',
                {
                    source: 'macro',
                    mode: 'live',
                    outcome: 'ignored',
                    booking: bookingIdAtCheckOut,
                    error: e
                }
            );
            return;
        }
        await blockCurrentBookingAutocancellation(
            AUTOCANCELLATION_BLOCK_REASON.CHECK_OUT_FAILED
        );
        logger.error(
            LOG_EVENT.CHECKOUT,
            '[BookingAutoCancellation] Checkout failed or not permitted on this meeting. Booking release aborted for safety.',
            {
                source: 'macro',
                mode: 'live',
                outcome: 'failed',
                booking: bookingIdAtCheckOut,
                reason: getCheckoutReason(bookingLifecycle.releaseWorkflow.releasePolicy),
                error: e
            }
        );
        cancelReleaseTimers();
        clearRoomUseCheckPrompt();
    }
}


// ------------------------------------------------------------------------------------------------------------
// -------------------------------------------- 12. Event Handlers --------------------------------------------
// ------------------------------------------------------------------------------------------------------------
// 12.1 User responses and CheckIn events

async function restoreDismissedRoomUseCheckPrompt(
    target,
    bookingGenerationAtStart,
    releaseWorkflowGenerationAtStart
) {
    if (target === 'Controller') {
        bookingLifecycle.releaseWorkflow.controllerPromptDisplayed = false;
    } else {
        bookingLifecycle.releaseWorkflow.osdPromptDisplayed = false;
    }
    logger.info(
        LOG_EVENT.PROMPT,
        `[BookingAutoCancellation] ${target} room use check prompt was dismissed without a selection; restoring it for the remaining warning duration.`
    );
    await refreshRoomUseCheckPromptPresentation(
        bookingGenerationAtStart,
        releaseWorkflowGenerationAtStart
    );
}

/**
 * Listens for user responses to the room use check prompt.
 * If the user selects "Keep Booking" (OptionId === '1'), auto-release timers are cancelled and the booking is maintained.
 * If the user selects "Check Out" (OptionId === '2'), confirmation is requested or CheckOut is executed.
 */
xapi.Event.UserInterface.Message.Prompt.Response.on(async (event) => {
    const isConfirming = bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation;
    const expectedControllerFeedbackId = isConfirming ?
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_CONTROLLER :
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER;
    const expectedOsdFeedbackId = isConfirming ?
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_OSD :
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_OSD;
    const responseMatchesOwnedRoomUseCheckPrompt = bookingLifecycle.releaseWorkflow.releasePhase === RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE &&
        ((event.FeedbackId === expectedControllerFeedbackId &&
            hasControllerRoomUseCheckPromptSurface() &&
            bookingLifecycle.releaseWorkflow.controllerPromptDisplayed) ||
        (event.FeedbackId === expectedOsdFeedbackId &&
            canUseInteractiveOsd() &&
            bookingLifecycle.releaseWorkflow.osdPromptDisplayed));

    if (!responseMatchesOwnedRoomUseCheckPrompt) {
        if (event.FeedbackId === ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER ||
            event.FeedbackId === ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_CONTROLLER ||
            event.FeedbackId === ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_OSD ||
            event.FeedbackId === ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_OSD) {
            logger.warn(
                LOG_EVENT.PROMPT,
                '[BookingAutoCancellation] Ignoring prompt response because no matching actionable room use check prompt is visible.'
            );
        }
        return;
    }

    const bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration;
    const releaseWorkflowGenerationAtStart = bookingLifecycle.releaseWorkflow.releaseWorkflowGeneration;
    const promptTarget = event.FeedbackId === expectedControllerFeedbackId ? 'Controller' : 'OSD';

    if (bookingLifecycle.releaseWorkflow.isCheckOutInProgress) {
        logger.warn(
            LOG_EVENT.PROMPT,
            '[BookingAutoCancellation] Ignoring prompt response while confirmed Check Out is in progress.'
        );
        return;
    }

    if (!isConfirming) {
        if (event.OptionId === ROOM_USE_CHECK_PROMPT.OPTIONS.KEEP_BOOKING.ID) {
            logger.info(
                LOG_EVENT.PROMPT,
                '[BookingAutoCancellation] User chose to keep the booking from the room use check prompt.'
            );
            bookingLifecycle.releaseWorkflow.hasUserSelectedKeepBooking = true;
            cancelRoomUseCheckPrompt();
            await reconcileRoomUseAfterManualReleaseCancellation('Keep Booking');
        } else if (event.OptionId === ROOM_USE_CHECK_PROMPT.OPTIONS.CHECK_OUT.ID) {
            logger.info(
                LOG_EVENT.PROMPT,
                '[BookingAutoCancellation] User requested check out; displaying confirmation guard prompt.'
            );
            bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation = true;
            bookingLifecycle.releaseWorkflow.controllerPromptDisplayed = false;
            bookingLifecycle.releaseWorkflow.osdPromptDisplayed = false;
            clearRoomUseCheckWarningPrompts();
            await refreshRoomUseCheckPromptPresentation(
                bookingGenerationAtStart,
                releaseWorkflowGenerationAtStart
            );
        } else {
            await restoreDismissedRoomUseCheckPrompt(
                promptTarget,
                bookingGenerationAtStart,
                releaseWorkflowGenerationAtStart
            );
        }
    } else {
        if (event.OptionId === ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.OPTIONS.CANCEL.ID) {
            logger.info(
                LOG_EVENT.PROMPT,
                '[BookingAutoCancellation] User chose to keep the booking from the check out confirmation prompt.'
            );
            bookingLifecycle.releaseWorkflow.hasUserSelectedKeepBooking = true;
            cancelRoomUseCheckPrompt();
            await reconcileRoomUseAfterManualReleaseCancellation('Cancel');
        } else if (event.OptionId === ROOM_USE_CHECK_PROMPT.CHECKOUT_CONFIRMATION.OPTIONS.CHECK_OUT.ID) {
            logger.info(
                LOG_EVENT.PROMPT,
                '[BookingAutoCancellation] User confirmed check out from the confirmation prompt.'
            );
            bookingLifecycle.releaseWorkflow.isCheckOutInProgress = true;
            await checkoutCurrentBookingOnUserConfirmation(
                bookingGenerationAtStart,
                releaseWorkflowGenerationAtStart
            );
        } else {
            await restoreDismissedRoomUseCheckPrompt(
                promptTarget,
                bookingGenerationAtStart,
                releaseWorkflowGenerationAtStart
            );
        }
    }
});

xapi.Event.UserInterface.Message.Prompt.Cleared.on(async (event) => {
    const feedbackId = event && event.FeedbackId;
    const isConfirming = bookingLifecycle.releaseWorkflow.isAwaitingCheckOutConfirmation;
    const expectedControllerFeedbackId = isConfirming ?
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_CONTROLLER :
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_CONTROLLER;
    const expectedOsdFeedbackId = isConfirming ?
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.CHECKOUT_CONFIRMATION_OSD :
        ROOM_USE_CHECK_PROMPT.FEEDBACK_IDS.WARNING_OSD;
    const dismissedControllerPrompt = feedbackId === expectedControllerFeedbackId &&
        hasControllerRoomUseCheckPromptSurface() &&
        bookingLifecycle.releaseWorkflow.controllerPromptDisplayed;
    const dismissedOsdPrompt = feedbackId === expectedOsdFeedbackId &&
        canUseInteractiveOsd() &&
        bookingLifecycle.releaseWorkflow.osdPromptDisplayed;

    if (bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE ||
        bookingLifecycle.releaseWorkflow.isCheckOutInProgress ||
        (!dismissedControllerPrompt && !dismissedOsdPrompt)) {
        return;
    }

    await restoreDismissedRoomUseCheckPrompt(
        dismissedControllerPrompt ? 'Controller' : 'OSD',
        bookingLifecycle.freshness.bookingGeneration,
        bookingLifecycle.releaseWorkflow.releaseWorkflowGeneration
    );
});

xapi.Event.Bookings.CheckedIn.on(async (event) => {
    const checkedInBookingId = event && event.Id;
    if (typeof checkedInBookingId !== 'string' || !checkedInBookingId) {
        logger.warn(
            LOG_EVENT.CHECKIN,
            '[BookingAutoCancellation] Ignoring RoomOS CheckedIn event without a booking ID.'
        );
        return;
    }

    if (checkedInBookingId === bookingLifecycle.booking.currentBookingId) {
        const wasAlreadyCheckedIn = hasRoomOsCheckedInCurrentBooking();
        const wasAwaitingStartupCheckIn = isCurrentBookingAutocancellationBlockedFor(
            AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
        );
        const wasNoShowReleaseActive = bookingLifecycle.releaseWorkflow.releasePolicy === RELEASE_POLICY.NO_SHOW;
        bookingLifecycle.checkIn.roomOsCheckedInBookingId = checkedInBookingId;
        if (bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId === checkedInBookingId) {
            bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId = null;
        }
        bookingLifecycle.checkIn.dryRunSimulatedCheckInBookingId = null;
        cancelAutomaticCheckIn();
        if (bookingLifecycle.releaseWorkflow.releasePolicy === RELEASE_POLICY.NO_SHOW) {
            cancelActiveReleaseWorkflow(RELEASE_CANCELLATION_REASON.MATCHING_CHECK_IN);
        }
        const checkInConfirmationRequired = !wasAlreadyCheckedIn || wasAwaitingStartupCheckIn || wasNoShowReleaseActive;
        if (wasAwaitingStartupCheckIn && !await allowCurrentBookingAfterStartupCheckIn()) {
            logger.warn(
                LOG_EVENT.CHECKIN,
                `[BookingAutoCancellation] CheckIn confirmed for booking ${checkedInBookingId}, but autocancellation remains paused because native CheckIn could not be restored.`,
                { booking: checkedInBookingId }
            );
            return;
        }
        if (checkInConfirmationRequired && !wasAwaitingStartupCheckIn) {
            logger.info(
                LOG_EVENT.CHECKIN,
                `[BookingAutoCancellation] CheckIn confirmed: booking ${checkedInBookingId}; autocancellation resumed.`
            );
        }
        if (checkInConfirmationRequired && bookingLifecycle.presence.roomUseState === ROOM_USE_STATE.EMPTY) {
            updateReleaseWorkflow();
        }
    } else {
        bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId = checkedInBookingId;
        logger.info(
            LOG_EVENT.CHECKIN,
            `[BookingAutoCancellation] Recorded RoomOS CheckedIn event for booking ${checkedInBookingId} pending current-booking reconciliation.`
        );
    }
});

// 12.2 Booking synchronization

function cancelBookingSyncCoalescing() {
    if (bookingSyncCoalescingTimer !== null) {
        clearTimeout(bookingSyncCoalescingTimer);
        bookingSyncCoalescingTimer = null;
    }
}

/**
 * Coalesces the BookedUntil and TimeStamp event burst before reading the
 * booking ID. A newer event version causes the read to retry rather than
 * applying a partial booking snapshot.
 */
function queueCurrentBookingSync() {
    if (!isCurrentBookingActive()) {
        cancelBookingSyncCoalescing();
        return Promise.resolve();
    }

    if (bookingSyncCoalescingTimer !== null) {
        clearTimeout(bookingSyncCoalescingTimer);
        bookingSyncCoalescingTimer = null;
    }

    const bookingGenerationAtStart = bookingLifecycle.freshness.bookingGeneration;

    if (CONFIG.BOOKING_SYNC_COALESCE_DELAY_MS <= 0) {
        if (pendingBookingSync !== null) {
            return pendingBookingSync;
        }
        pendingBookingSync = Promise.resolve()
            .then(syncCurrentBookingFromRoomOs)
            .finally(() => {
                pendingBookingSync = null;
                reconcileCurrentBookingReadinessRecovery();
            });
        return pendingBookingSync;
    }

    bookingSyncCoalescingTimer = setTimeout(async () => {
        bookingSyncCoalescingTimer = null;
        if (!isCurrentBookingActive() || !isSameBookingLifecycle(bookingGenerationAtStart)) {
            return;
        }
        await syncCurrentBookingFromRoomOs();
        reconcileCurrentBookingReadinessRecovery();
    }, CONFIG.BOOKING_SYNC_COALESCE_DELAY_MS);

    return Promise.resolve();
}

function cancelBookingReadinessRecovery() {
    bookingReadinessRecoveryGeneration += 1;
    if (bookingReadinessRecoveryTimer !== null) {
        clearTimeout(bookingReadinessRecoveryTimer);
        bookingReadinessRecoveryTimer = null;
    }
    bookingReadinessRecoveryAttempt = 0;
    bookingReadinessRecoveryExhausted = false;
}

function invalidateBookingReadinessRecovery() {
    bookingReadinessRecoveryGeneration += 1;
    if (bookingReadinessRecoveryTimer !== null) {
        clearTimeout(bookingReadinessRecoveryTimer);
        bookingReadinessRecoveryTimer = null;
    }
    if (bookingReadinessRecoveryExhausted) {
        bookingReadinessRecoveryAttempt = 0;
        bookingReadinessRecoveryExhausted = false;
    }
}

function getBookingReadinessRecoveryDelayMs(attempt) {
    if (!Array.isArray(CONFIG.BOOKING_READINESS_RECOVERY_DELAYS_MS) ||
        attempt < 0 ||
        attempt >= CONFIG.BOOKING_READINESS_RECOVERY_DELAYS_MS.length) {
        return null;
    }
    const delay = CONFIG.BOOKING_READINESS_RECOVERY_DELAYS_MS[attempt];
    return Number.isFinite(delay) && delay >= 0 ? delay : null;
}

function isCurrentBookingReadinessRecoveryNeeded() {
    const blockReason = bookingLifecycle.autocancellation.status.blockReason;
    const startupCheckInSettingUnavailable = blockReason ===
        AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN &&
        !bookingLifecycle.autocancellation.status.nativeCheckInSettingApplied;
    const longMeetingSettingUnavailable = blockReason ===
        AUTOCANCELLATION_BLOCK_REASON.LONG_MEETING &&
        !bookingLifecycle.autocancellation.status.nativeCheckInSettingApplied;
    return isCurrentBookingActive() &&
        (RETRYABLE_AUTOCANCELLATION_BLOCK_REASONS[blockReason] === true ||
        startupCheckInSettingUnavailable ||
        longMeetingSettingUnavailable ||
        (blockReason === AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN &&
        (!bookingLifecycle.booking.currentBookingId ||
        !isFutureTimestamp(bookingLifecycle.booking.currentBookingEndTime))));
}

function reconcileCurrentBookingReadinessRecovery() {
    if (isCurrentBookingReadinessRecoveryNeeded()) {
        scheduleBookingReadinessRecovery(captureCurrentBookingContext());
        return;
    }
    if (!isCurrentBookingActive() ||
        bookingLifecycle.autocancellation.status.status === AUTOCANCELLATION_STATUS.ALLOWED ||
        RETRYABLE_AUTOCANCELLATION_BLOCK_REASONS[bookingLifecycle.autocancellation.status.blockReason] !== true) {
        cancelBookingReadinessRecovery();
    }
}

function scheduleBookingReadinessRecovery(currentBookingContext) {
    if (!isCurrentBookingActive() ||
        !isBookingContextStillCurrent(currentBookingContext) ||
        !isCurrentBookingReadinessRecoveryNeeded() ||
        bookingReadinessRecoveryTimer !== null ||
        bookingReadinessRecoveryExhausted) {
        return;
    }

    const delay = getBookingReadinessRecoveryDelayMs(bookingReadinessRecoveryAttempt);
    if (delay === null) {
        bookingReadinessRecoveryExhausted = true;
        if (isCurrentBookingActive() &&
            (!bookingLifecycle.booking.currentBookingId ||
            getTimestampMs(bookingLifecycle.booking.currentBookingEndTime) === null)) {
            logLongMeetingVerificationFailure(
                bookingLifecycle.booking.currentBookingId,
                'snapshot_incomplete',
                `status=${formatLogValue(bookingLifecycle.booking.availabilityStatus)} currentBookingId=${formatLogValue(bookingLifecycle.booking.currentBookingId)} currentBookingEndTime=${formatLogValue(bookingLifecycle.booking.currentBookingEndTime)} lookup=not_attempted`
            );
        }
        logger.warn(
            LOG_EVENT.READINESS,
            `[BookingAutoCancellation] Booking readiness recovery exhausted for booking ${currentBookingContext.bookingId || '(identity unavailable)'}; autocancellation remains suspended until another RoomOS event or health check.`
        );
        return;
    }

    const recoveryAttempt = bookingReadinessRecoveryAttempt + 1;
    const bookingReadinessRecoveryGenerationAtStart = bookingReadinessRecoveryGeneration;
    bookingReadinessRecoveryAttempt = recoveryAttempt;
    bookingReadinessRecoveryTimer = setTimeout(
        () => recoverCurrentBookingReadiness(
            currentBookingContext,
            bookingReadinessRecoveryGenerationAtStart
        ),
        delay
    );
    logger.debug(
        LOG_EVENT.READINESS,
        `[BookingAutoCancellation] Booking readiness recovery scheduled for booking ${currentBookingContext.bookingId || '(identity unavailable)'}: attempt=${recoveryAttempt} in ${delay}ms; reason=${bookingLifecycle.autocancellation.status.blockReason}.`
    );
}

async function recoverCurrentBookingReadiness(
    currentBookingContext,
    bookingReadinessRecoveryGenerationAtStart
) {
    const bookingGenerationAtStart = currentBookingContext.bookingGeneration;
    const bookingIdAtStart = currentBookingContext.bookingId;
    bookingReadinessRecoveryTimer = null;
    if (bookingReadinessRecoveryGeneration !== bookingReadinessRecoveryGenerationAtStart ||
        !isSameBookingLifecycle(currentBookingContext.bookingGeneration) ||
        !isCurrentBookingReadinessRecoveryNeeded()) {
        return;
    }

    const readinessRestored = await reconcileAutocancellationReadiness(false, true);
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        (bookingIdAtStart && bookingLifecycle.booking.currentBookingId !== bookingIdAtStart)) {
        return;
    }
    if (!readinessRestored) {
        reconcileCurrentBookingReadinessRecovery();
        updateReleaseWorkflow();
        return;
    }
    logger.debug(
        LOG_EVENT.READINESS,
        '[BookingAutoCancellation] Booking readiness recovery completed.',
        {
            booking: bookingLifecycle.booking.currentBookingId,
            status: bookingLifecycle.autocancellation.status.status,
            reason: bookingLifecycle.autocancellation.status.blockReason
        }
    );
    updateReleaseWorkflow();
}

async function syncCurrentBookingFromRoomOs() {
    if (!bookingLifecycle.autocancellation.areRequiredConfigurationsHealthy) {
        if (!await recoverAutocancellationFromStatusEvent(
            isInitializing && !hasReceivedActiveBookingEventWhileInitializing
        )) {
            updateReleaseWorkflow();
            return;
        }
    }

    while (isCurrentBookingActive()) {
        const eventVersionAtReadStart = bookingLifecycle.freshness.runtimeStateVersion;
        const lifecycleIdAtReadStart = bookingLifecycle.freshness.bookingGeneration;
        const observedBookingId = await xapi.Status.Bookings.Current.Id.get().catch(() => null);

        if (!isCurrentBookingActive() || !isSameBookingLifecycle(lifecycleIdAtReadStart)) {
            return;
        }

        // If another event arrived during the read, retry so paired BookedUntil
        // and TimeStamp updates are applied as one current snapshot.
        if (bookingLifecycle.freshness.runtimeStateVersion !== eventVersionAtReadStart) {
            continue;
        }

        const knownBookingId = bookingLifecycle.booking.currentBookingId;
        const hasMatchingPendingRoomOsCheckIn =
            bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId === observedBookingId;
        if (knownBookingId && knownBookingId !== observedBookingId) {
            beginNewBookingLifecycle(hasMatchingPendingRoomOsCheckIn);
        }
        bookingLifecycle.booking.currentBookingId = observedBookingId;
        if (hasMatchingPendingRoomOsCheckIn) {
            consumePendingRoomOsCheckInForCurrentBooking();
        }

        const policyApplied = await evaluateAndApplyCurrentBookingAutocancellationPolicy();
        if (!policyApplied &&
            isCurrentBookingActive() &&
            isSameBookingLifecycle(lifecycleIdAtReadStart) &&
            bookingLifecycle.freshness.runtimeStateVersion !== eventVersionAtReadStart) {
            continue;
        }
        if (!policyApplied) {
            updateReleaseWorkflow();
            return;
        }
        scheduleAutomaticCheckIn();
        updateReleaseWorkflow();
        return;
    }
}

// 12.3 Status subscriptions and transitions

/**
 * Revalidates presence after a user keeps the booking or manual checkout is
 * cancelled. Either outcome suppresses the current warning; a verified empty
 * room may begin a new policy-selected release countdown.
 */
async function reconcileRoomUseAfterManualReleaseCancellation(cancellationDescription) {
    const currentBookingContext = captureCurrentBookingContext();
    let roomInUseStatus = null;
    try {
        roomInUseStatus = await xapi.Status.RoomAnalytics.RoomInUse.get();
    } catch (error) {
        logger.warn(
            LOG_EVENT.PRESENCE,
            `[BookingAutoCancellation] RoomInUse could not be revalidated after ${cancellationDescription}; booking autocancellation is suspended.`,
            { error }
        );
    }

    if (!isBookingContextStillCurrent(currentBookingContext)) {
        logger.debug(
            LOG_EVENT.STALE_STATE,
            `[BookingAutoCancellation] Ignoring RoomInUse revalidation after ${cancellationDescription} because the booking state changed.`
        );
        return;
    }

    await applyRoomUseStatusTransition(roomInUseStatus, true);
}

/**
 * Applies RoomInUse changes. Unknown values suspend automation; only a
 * verified Occupied or Empty state may drive CheckIn or release decisions.
 */
async function applyRoomUseStatusTransition(status, forceReevaluation = false) {
    bookingLifecycle.freshness.runtimeStateVersion += 1;
    const roomUseState = parseRoomUseState(status);
    if (roomUseState === ROOM_USE_STATE.UNKNOWN) {
        bookingLifecycle.presence.isRoomUseStatusSupported = false;
        bookingLifecycle.presence.roomUseState = ROOM_USE_STATE.UNKNOWN;
        bookingLifecycle.presence.lastHandledRoomUseState = null;
        cancelAutomaticCheckIn();
        cancelRoomUseCheckPrompt();
        await blockCurrentBookingAutocancellation(
            AUTOCANCELLATION_BLOCK_REASON.ROOM_USE_STATUS_UNAVAILABLE
        );
        logger.warn(
            LOG_EVENT.PRESENCE,
            `[BookingAutoCancellation] RoomInUse reported an unknown value; roomUseState=${bookingLifecycle.presence.roomUseState}. Booking autocancellation is suspended until presence can be revalidated.`,
            { status, roomUseState: bookingLifecycle.presence.roomUseState }
        );
        return;
    }

    if (!isBookingAutomationReady()) {
        logger.debug(
            LOG_EVENT.PRESENCE,
            '[BookingAutoCancellation] RoomInUse observed while readiness was unavailable; recovering RoomOS state.',
            {
                status,
                roomUseState,
                booking: bookingLifecycle.booking.currentBookingId
            }
        );
        if (!await recoverAutocancellationFromStatusEvent(
            isInitializing && !hasReceivedActiveBookingEventWhileInitializing
        )) {
            updateReleaseWorkflow();
            return;
        }
        return;
    }

    if (!forceReevaluation &&
        roomUseState === bookingLifecycle.presence.lastHandledRoomUseState) {
        return;
    }

    bookingLifecycle.presence.lastHandledRoomUseState = roomUseState;
    bookingLifecycle.presence.roomUseState = roomUseState;
    logger.info(
        LOG_EVENT.PRESENCE,
        `[BookingAutoCancellation] RoomInUse updated: ${status} | roomUseState=${bookingLifecycle.presence.roomUseState} | booking: ${bookingLifecycle.booking.currentBookingId || '(none)'}`
    );
    if (bookingLifecycle.presence.roomUseState === ROOM_USE_STATE.OCCUPIED) {
        if (bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.PROMPT_VISIBLE) {
            cancelActiveReleaseWorkflow(RELEASE_CANCELLATION_REASON.ROOM_CONFIRMED_IN_USE);
            scheduleAutomaticCheckIn();
        } else {
            logger.info(
                LOG_EVENT.PRESENCE,
                '[BookingAutoCancellation] Presence detected while room use check prompt is visible; retaining prompt for user action.'
            );
        }
    } else {
        cancelAutomaticCheckIn();
    }
    updateReleaseWorkflow();
}

/**
 * Applies the three-state availability value and reconciles booking identity,
 * native CheckIn, and release timers when the current booking changes or ends.
 */
async function applyBookingAvailabilityTransition(status) {
    bookingLifecycle.freshness.runtimeStateVersion += 1;
    if (isInitializing && status === BOOKING_STATUS.BOOKED_UNTIL) {
        hasReceivedActiveBookingEventWhileInitializing = true;
    }
    const previousStatus = bookingLifecycle.booking.availabilityStatus;
    const previousBookingId = bookingLifecycle.booking.currentBookingId;
    const previousBookingEndTime = bookingLifecycle.booking.currentBookingEndTime;
    bookingLifecycle.booking.availabilityStatus = status;
    logger.info(
        LOG_EVENT.AVAILABILITY,
        `[BookingAutoCancellation] Booking availability status updated: ${bookingLifecycle.booking.availabilityStatus}`
    );

    if (isCurrentBookingInactive()) {
        const wasMacroCheckoutObserved = previousStatus === BOOKING_STATUS.BOOKED_UNTIL &&
            consumePendingMacroCheckout(previousBookingId, previousBookingEndTime);
        if (previousStatus === BOOKING_STATUS.BOOKED_UNTIL &&
            previousBookingId &&
            isFutureTimestamp(previousBookingEndTime) &&
            !wasMacroCheckoutObserved) {
            logger.info(
                LOG_EVENT.EXTERNAL_CHECKOUT_OBSERVED,
                `[BookingAutoCancellation] [EXTERNAL_RELEASE_OBSERVED] Booking ID ${previousBookingId} was released externally before its scheduled end; RoomOS reported ${status}.`,
                {
                    source: 'external',
                    mode: 'live',
                    outcome: 'observed',
                    booking: previousBookingId,
                    meetingStart: bookingLifecycle.booking.currentBookingStartTime,
                    meetingEnd: previousBookingEndTime,
                    status
                }
            );
        }
        const bookingEnded = previousStatus !== bookingLifecycle.booking.availabilityStatus;
        if (bookingEnded) {
            beginNewBookingLifecycle();
        } else {
            cancelRoomUseCheckPrompt();
            bookingLifecycle.booking.currentBookingStartTime = '';
        }
        bookingLifecycle.booking.currentBookingId = null;
        bookingLifecycle.booking.currentBookingEndTime = '';
        bookingLifecycle.booking.nextBookingStartTime = '';
        if (bookingLifecycle.booking.availabilityStatus === BOOKING_STATUS.FREE) {
            logger.info(
                LOG_EVENT.AVAILABILITY,
                '[BookingAutoCancellation] Room is free with no upcoming booking. Resolving active timers and clearing panel prompts.'
            );
        } else {
            logger.info(
                LOG_EVENT.AVAILABILITY,
                '[BookingAutoCancellation] Current booking has ended; a later booking exists. Resolving active timers and clearing panel prompts.'
            );
        }
        cancelAutomaticCheckIn();
        if (!await restoreNativeCheckInWhenNoBooking()) {
            updateReleaseWorkflow();
            return;
        }
    }

    if (isCurrentBookingActive()) {
        invalidateBookingReadinessRecovery();
        return queueCurrentBookingSync();
    }

    updateReleaseWorkflow();
}

/**
 * Applies Availability.TimeStamp according to the current availability status.
 * Under continuous occupancy across sequential booking boundaries, this is
 * the transition point where the new booking end becomes authoritative.
 */
function applyBookingTimeTransition(availabilityTime) {
    bookingLifecycle.freshness.runtimeStateVersion += 1;
    if (isCurrentBookingActive()) {
        const wasAwaitingStartupCheckIn = isCurrentBookingAutocancellationBlockedFor(
            AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
        );
        const nextCurrentBookingEndTime = isFutureTimestamp(availabilityTime) ? availabilityTime : '';
        invalidateBookingReadinessRecovery();
        if (bookingLifecycle.booking.currentBookingEndTime !== nextCurrentBookingEndTime) {
            bookingLifecycle.booking.currentBookingStartTime = '';
        }
        bookingLifecycle.booking.currentBookingEndTime = nextCurrentBookingEndTime;
        bookingLifecycle.booking.nextBookingStartTime = '';
        if (wasAwaitingStartupCheckIn) {
            recordCurrentBookingAutocancellationStatus(
                createAutocancellationPolicyDecision(
                    AUTOCANCELLATION_STATUS.BLOCKED,
                    AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
                )
            );
        }
        if (bookingLifecycle.booking.currentBookingEndTime) {
            logger.info(
                LOG_EVENT.AVAILABILITY,
                `[BookingAutoCancellation] Current booking end time updated: ${bookingLifecycle.booking.currentBookingEndTime}`
            );
        } else {
            cancelAutomaticCheckIn();
            logger.warn(
                LOG_EVENT.AVAILABILITY,
                '[BookingAutoCancellation] Ignoring stale availability time for the current booking:',
                { timestamp: availabilityTime || '(empty)' }
            );
        }
    } else if (bookingLifecycle.booking.availabilityStatus === BOOKING_STATUS.FREE_UNTIL) {
        bookingLifecycle.booking.currentBookingStartTime = '';
        bookingLifecycle.booking.currentBookingEndTime = '';
        bookingLifecycle.booking.nextBookingStartTime = availabilityTime;
        logger.info(
            LOG_EVENT.AVAILABILITY,
            `[BookingAutoCancellation] Upcoming booking start time updated: ${bookingLifecycle.booking.nextBookingStartTime}`
        );
    } else {
        bookingLifecycle.booking.currentBookingStartTime = '';
        bookingLifecycle.booking.currentBookingEndTime = '';
        bookingLifecycle.booking.nextBookingStartTime = '';
        logger.info(
            LOG_EVENT.AVAILABILITY,
            '[BookingAutoCancellation] Availability timestamp cleared because there is no current booking.'
        );
    }

    if (isCurrentBookingActive()) {
        return queueCurrentBookingSync();
    }
    updateReleaseWorkflow();
}

// Status subscriptions stay active during initialization. Event markers let
// newer event-derived state win over slower startup reads.
xapi.Status.RoomAnalytics.RoomInUse.on(applyRoomUseStatusTransition);
xapi.Status.Bookings.Availability.Status.on(applyBookingAvailabilityTransition);
xapi.Status.Bookings.Availability.TimeStamp.on(applyBookingTimeTransition);
xapi.Status.Peripherals.ConnectedDevice.on(async () => {
    await refreshControllerRoomUseCheckPromptSurface();
});

// ------------------------------------------------------------------------------------------------------------
// --------------------------------------- 13. Initialization and Recovery ------------------------------------
// ------------------------------------------------------------------------------------------------------------

// 13.1 Required RoomOS configuration

async function ensureRequiredAutocancellationConfigurations(publishHealth = true) {
    let configurationHealthy = true;
    logger.info(
        LOG_EVENT.CONFIGURATION,
        CONFIG.DRY_RUN_MODE ?
            '[BookingAutoCancellation] Configuring required presence detection; dry run disables native CheckIn...' :
            '[BookingAutoCancellation] Ensuring required presence detection configurations are active...'
    );
    try {
        await xapi.Config.RoomAnalytics.PeoplePresenceDetector.set('On');
        logger.info(LOG_EVENT.CONFIGURATION, '[BookingAutoCancellation] Enforced PeoplePresenceDetector: On');
    } catch (e) {
        configurationHealthy = false;
        logger.warn(
            LOG_EVENT.CONFIGURATION,
            '[BookingAutoCancellation] Could not force PeoplePresenceDetector config:',
            { setting: 'RoomAnalytics.PeoplePresenceDetector', error: e }
        );
    }

    try {
        await xapi.Config.RoomAnalytics.PeoplePresence.Input.HeadDetector.set('On');
        logger.info(LOG_EVENT.CONFIGURATION, '[BookingAutoCancellation] Enforced PeoplePresence.Input.HeadDetector: On');
    } catch (e) {
        configurationHealthy = false;
        logger.warn(
            LOG_EVENT.CONFIGURATION,
            '[BookingAutoCancellation] HeadDetector config not supported/permitted on this codec:',
            { setting: 'RoomAnalytics.PeoplePresence.Input.HeadDetector', error: e }
        );
    }

    try {
        await xapi.Config.RoomAnalytics.PeopleCountOutOfCall.set('On');
        logger.info(LOG_EVENT.CONFIGURATION, '[BookingAutoCancellation] Enforced PeopleCountOutOfCall: On');
    } catch (e) {
        configurationHealthy = false;
        logger.warn(
            LOG_EVENT.CONFIGURATION,
            '[BookingAutoCancellation] PeopleCountOutOfCall config not supported/permitted on this codec:',
            { setting: 'RoomAnalytics.PeopleCountOutOfCall', error: e }
        );
    }

    try {
        const ultrasoundSetting = CONFIG.ULTRASOUND_SENSOR_ENABLED ? 'On' : 'Off';
        await xapi.Config.RoomAnalytics.PeoplePresence.Input.Ultrasound.set(ultrasoundSetting);
        logger.info(
            LOG_EVENT.CONFIGURATION,
            `[BookingAutoCancellation] Enforced PeoplePresence.Input.Ultrasound: ${ultrasoundSetting}`
        );
    } catch (e) {
        configurationHealthy = false;
        logger.warn(
            LOG_EVENT.CONFIGURATION,
            '[BookingAutoCancellation] Ultrasound config not supported/permitted on this codec:',
            { setting: 'RoomAnalytics.PeoplePresence.Input.Ultrasound', error: e }
        );
    }

    try {
        await xapi.Config.RoomAnalytics.RoomInUse.InCall.set('Enabled');
        logger.info(LOG_EVENT.CONFIGURATION, '[BookingAutoCancellation] Enforced RoomInUse.InCall: Enabled');
    } catch (e) {
        configurationHealthy = false;
        logger.warn(
            LOG_EVENT.CONFIGURATION,
            '[BookingAutoCancellation] RoomInUse.InCall config not supported/permitted on this codec:',
            { setting: 'RoomAnalytics.RoomInUse.InCall', error: e }
        );
    }

    try {
        await xapi.Config.RoomAnalytics.RoomInUse.LocalUsage.set('Enabled');
        logger.info(LOG_EVENT.CONFIGURATION, '[BookingAutoCancellation] Enforced RoomInUse.LocalUsage: Enabled');
    } catch (e) {
        configurationHealthy = false;
        logger.warn(
            LOG_EVENT.CONFIGURATION,
            '[BookingAutoCancellation] RoomInUse.LocalUsage config not supported/permitted on this codec:',
            { setting: 'RoomAnalytics.RoomInUse.LocalUsage', error: e }
        );
    }

    try {
        if (!hasValidLongMeetingExemptionConfiguration() ||
            !hasValidNativeCheckInWindowConfiguration()) {
            throw new Error('Invalid long-meeting or native CheckIn window configuration');
        }
        await xapi.Config.Bookings.CheckIn.WindowDuration.set(String(CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES));
        logger.info(
            LOG_EVENT.CONFIGURATION,
            `[BookingAutoCancellation] Enforced Bookings.CheckIn.WindowDuration: ${CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES}`
        );
    } catch (e) {
        configurationHealthy = false;
        logger.warn(
            LOG_EVENT.CONFIGURATION,
            '[BookingAutoCancellation] Bookings.CheckIn.WindowDuration config not supported/permitted on this codec:',
            { setting: 'Bookings.CheckIn.WindowDuration', error: e }
        );
    }

    if (CONFIG.DRY_RUN_MODE) {
        try {
            const nativeCheckInEnabled = await xapi.Config.Bookings.CheckIn.Enabled.get();
            if (String(nativeCheckInEnabled) !== 'False') {
                await xapi.Config.Bookings.CheckIn.Enabled.set('False');
                logger.info(
                    LOG_EVENT.CONFIGURATION,
                    `[BookingAutoCancellation] Enforced Bookings.CheckIn.Enabled: False for dry-run observation (was ${nativeCheckInEnabled || '(unavailable)'}).`
                );
            } else {
                logger.info(
                    LOG_EVENT.CONFIGURATION,
                    '[BookingAutoCancellation] Observed Bookings.CheckIn.Enabled: False; dry run left it unchanged.'
                );
            }
        } catch (e) {
            configurationHealthy = false;
            logger.warn(
                LOG_EVENT.CONFIGURATION,
                '[BookingAutoCancellation] Could not ensure Bookings.CheckIn.Enabled is False for dry-run observation:',
                { setting: 'Bookings.CheckIn.Enabled', value: 'False', error: e }
            );
        }
    }

    if (publishHealth) {
        bookingLifecycle.autocancellation.areRequiredConfigurationsHealthy = configurationHealthy;
    }
    return configurationHealthy;
}

// 13.2 Readiness and recovery

async function reconcileAutocancellationReadiness(
    shouldQuarantineStartupBooking = false,
    allowBookingDetailsFallback = false
) {
    const currentBookingContext = captureCurrentBookingContext();
    const bookingGenerationAtStart = currentBookingContext.bookingGeneration;
    const runtimeStateVersionAtStart = currentBookingContext.runtimeStateVersion;
    const bookingIdAtStart = currentBookingContext.bookingId;
    const endTimestampAtStart = currentBookingContext.currentBookingEndTime;
    const shouldReassessAutocancellationStatus = !isEnvironmentReadyForAutomation();
    const configurationHealthy = await ensureRequiredAutocancellationConfigurations(false);
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameStatusEventVersion(runtimeStateVersionAtStart)) {
        return false;
    }
    bookingLifecycle.autocancellation.areRequiredConfigurationsHealthy = configurationHealthy;
    if (!configurationHealthy) {
        await blockCurrentBookingAutocancellation(
            AUTOCANCELLATION_BLOCK_REASON.REQUIRED_CONFIGURATIONS_UNAVAILABLE,
            currentBookingContext
        );
        return false;
    }

    const roomInUseStatus = await xapi.Status.RoomAnalytics.RoomInUse.get().catch(() => null);
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameStatusEventVersion(runtimeStateVersionAtStart)) {
        return false;
    }
    const recoveredRoomUseState = parseRoomUseState(roomInUseStatus);
    if (recoveredRoomUseState === ROOM_USE_STATE.UNKNOWN) {
        bookingLifecycle.presence.isRoomUseStatusSupported = false;
        await blockCurrentBookingAutocancellation(
            AUTOCANCELLATION_BLOCK_REASON.ROOM_USE_STATUS_UNAVAILABLE,
            currentBookingContext
        );
        return false;
    }

    const currentBooking = await readCurrentBookingSnapshot(
        bookingGenerationAtStart,
        runtimeStateVersionAtStart,
        allowBookingDetailsFallback
    );
    if (!isSameStatusEventVersion(runtimeStateVersionAtStart)) {
        return false;
    }
    if (!currentBooking ||
        !Object.values(BOOKING_STATUS).includes(currentBooking.availabilityStatus)) {
        await blockCurrentBookingAutocancellation(
            AUTOCANCELLATION_BLOCK_REASON.COULD_NOT_VERIFY_CURRENT_BOOKING,
            currentBookingContext
        );
        return false;
    }

    if (currentBooking.availabilityStatus === BOOKING_STATUS.BOOKED_UNTIL) {
        if (!currentBooking.currentBookingId || !isFutureTimestamp(currentBooking.currentBookingEndTime)) {
            await blockCurrentBookingAutocancellation(
                AUTOCANCELLATION_BLOCK_REASON.COULD_NOT_VERIFY_CURRENT_BOOKING,
                currentBookingContext
            );
            return false;
        }
    }

    const codecTime = await xapi.Status.Time.SystemTime.get().catch(() => null);
    if (!isSameBookingLifecycle(bookingGenerationAtStart) ||
        !isSameStatusEventVersion(runtimeStateVersionAtStart)) {
        return false;
    }

    bookingLifecycle.presence.roomUseState = recoveredRoomUseState;
    bookingLifecycle.presence.lastHandledRoomUseState = recoveredRoomUseState;
    bookingLifecycle.presence.isRoomUseStatusSupported = true;
    bookingLifecycle.booking.availabilityStatus = currentBooking.availabilityStatus;
    bookingLifecycle.booking.nextBookingStartTime = currentBooking.availabilityStatus === BOOKING_STATUS.FREE_UNTIL ?
        currentBooking.nextBookingStartTime : '';

    if (currentBooking.availabilityStatus === BOOKING_STATUS.BOOKED_UNTIL) {
        const hasMatchingPendingRoomOsCheckIn =
            bookingLifecycle.checkIn.pendingRoomOsCheckedInBookingId === currentBooking.currentBookingId;
        const startupQuarantineBelongsToCurrentBooking = !bookingIdAtStart ||
            bookingIdAtStart === currentBooking.currentBookingId;
        const shouldQuarantineCurrentBooking = (shouldQuarantineStartupBooking ||
            isStartupCheckInQuarantineActive()) &&
            startupQuarantineBelongsToCurrentBooking &&
            !hasMatchingPendingRoomOsCheckIn &&
            bookingLifecycle.checkIn.roomOsCheckedInBookingId !== currentBooking.currentBookingId;
        if (bookingLifecycle.booking.currentBookingId &&
            bookingLifecycle.booking.currentBookingId !== currentBooking.currentBookingId) {
            beginNewBookingLifecycle(hasMatchingPendingRoomOsCheckIn);
        }
        bookingLifecycle.booking.currentBookingId = currentBooking.currentBookingId;
        if (bookingLifecycle.booking.currentBookingEndTime !== currentBooking.currentBookingEndTime) {
            bookingLifecycle.booking.currentBookingStartTime = '';
        }
        bookingLifecycle.booking.currentBookingEndTime = currentBooking.currentBookingEndTime;
        if (hasMatchingPendingRoomOsCheckIn) {
            consumePendingRoomOsCheckInForCurrentBooking();
        }
        if (shouldQuarantineCurrentBooking) {
            recordCurrentBookingAutocancellationStatus(
                createAutocancellationPolicyDecision(
                    AUTOCANCELLATION_STATUS.BLOCKED,
                    AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
                )
            );
        }
        if (!await evaluateAndApplyCurrentBookingAutocancellationPolicy(
            shouldReassessAutocancellationStatus || allowBookingDetailsFallback,
            currentBooking.currentBookingDetailsResponse
        )) {
            return false;
        }
        if (isCurrentBookingAutocancellationBlockedFor(
            AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
        )) {
            const checkInStateRestored = hasRoomOsCheckedInCurrentBooking() ?
            await allowCurrentBookingAfterStartupCheckIn() :
            await quarantineCurrentBookingUntilCheckIn();
            if (!checkInStateRestored) {
                return false;
            }
        }
    } else {
        bookingLifecycle.booking.currentBookingStartTime = '';
        if (bookingLifecycle.booking.currentBookingId !== null ||
            bookingLifecycle.releaseWorkflow.releasePhase !== RELEASE_WORKFLOW_PHASE.IDLE) {
            beginNewBookingLifecycle();
        }
        bookingLifecycle.booking.currentBookingId = null;
        bookingLifecycle.booking.currentBookingEndTime = '';
        if (!await restoreNativeCheckInWhenNoBooking()) {
            return false;
        }
    }

    if (!await scheduleMidnightHealthCheck(codecTime)) {
        return false;
    }

    if (currentBooking.availabilityStatus === BOOKING_STATUS.BOOKED_UNTIL &&
        isCurrentBookingAutocancellationBlocked()) {
        return true;
    }
    scheduleAutomaticCheckIn();
    return true;
}

async function recoverAutocancellationFromStatusEvent(shouldQuarantineStartupBooking = false) {
    const readinessRestored = await reconcileAutocancellationReadiness(
        shouldQuarantineStartupBooking
    );
    if (!readinessRestored) {
        return false;
    }
    logger.debug(
        LOG_EVENT.READINESS,
        '[BookingAutoCancellation] Status-event recovery restored RoomOS readiness.',
        {
            booking: bookingLifecycle.booking.currentBookingId,
            status: bookingLifecycle.autocancellation.status.status,
            reason: bookingLifecycle.autocancellation.status.blockReason
        }
    );
    updateReleaseWorkflow();
    return true;
}

async function reconcileStartupAfterEventRace() {
    logger.warn(
        LOG_EVENT.STARTUP,
        '[BookingAutoCancellation] Startup reconciliation adopted event-derived state; initial reads are stale.'
    );
    const readinessRestored = await reconcileAutocancellationReadiness(
        !hasReceivedActiveBookingEventWhileInitializing
    );
    if (!readinessRestored) {
        updateReleaseWorkflow();
        return false;
    }
    updateReleaseWorkflow();
    return true;
}

// 13.3 Startup sequence

async function init() {
    const initializationVersion = bookingLifecycle.freshness.runtimeStateVersion;
    isInitializing = true;
    hasReceivedActiveBookingEventWhileInitializing = false;
    try {
        logger.info(
            LOG_EVENT.STARTUP,
            `[BookingAutoCancellation] Runtime identity: ${MACRO_INFO.NAME} version=${MACRO_INFO.VERSION} mode=${CONFIG.DRY_RUN_MODE ? 'dry_run' : 'live'}.`,
            {
                macro: MACRO_INFO.NAME,
                version: MACRO_INFO.VERSION,
                mode: CONFIG.DRY_RUN_MODE ? 'dry_run' : 'live'
            }
        );
        if (CONFIG.DRY_RUN_MODE) {
            logger.warn(
                LOG_EVENT.STARTUP,
                '[BookingAutoCancellation] [DRY RUN MODE ACTIVE] RoomAnalytics configured; native Bookings.CheckIn.Enabled disabled; NO macro booking commands or UI.'
            );
        }

        // Configure RoomOS presence, discover prompt surfaces, reconcile the
        // current booking, quarantine active startup bookings, schedule
        // midnight recovery, then evaluate automatic actions.
        //
        // An active booking found during startup is quarantined until a
        // matching RoomOS CheckedIn event proves its CheckIn provenance.
        // This prevents a restart from treating an existing meeting as a new
        // no-show booking.
        const configurationHealthy = await ensureRequiredAutocancellationConfigurations();
        if (!configurationHealthy) {
            logger.error(
                LOG_EVENT.CONFIGURATION,
                '[BookingAutoCancellation] Required configuration is not healthy. Booking autocancellation is disabled.'
            );
            return;
        }
        
        roomUseCheckPromptSurface.productPlatform = await xapi.Status.SystemUnit.ProductPlatform.get().catch(() => null);
        await refreshControllerRoomUseCheckPromptSurface();

        const roomInUse = await xapi.Status.RoomAnalytics.RoomInUse.get();
        const initialRoomUseState = parseRoomUseState(roomInUse);
        
        const initialBooking = await readCurrentBookingSnapshot();
        if (bookingLifecycle.freshness.runtimeStateVersion !== initializationVersion) {
            await reconcileStartupAfterEventRace();
            return;
        }
        if (!initialBooking || !Object.values(BOOKING_STATUS).includes(initialBooking.availabilityStatus)) {
            throw new Error(`Unknown booking availability status: ${initialBooking && initialBooking.availabilityStatus}`);
        }

        bookingLifecycle.presence.roomUseState = initialRoomUseState;
        bookingLifecycle.presence.lastHandledRoomUseState = initialRoomUseState;
        bookingLifecycle.presence.isRoomUseStatusSupported = initialRoomUseState !== ROOM_USE_STATE.UNKNOWN;
        bookingLifecycle.booking.availabilityStatus = initialBooking.availabilityStatus;
        bookingLifecycle.booking.currentBookingId = initialBooking.currentBookingId;
        bookingLifecycle.booking.currentBookingEndTime = initialBooking.availabilityStatus === BOOKING_STATUS.BOOKED_UNTIL &&
            isFutureTimestamp(initialBooking.currentBookingEndTime) ? initialBooking.currentBookingEndTime : '';
        bookingLifecycle.booking.nextBookingStartTime = initialBooking.availabilityStatus === BOOKING_STATUS.FREE_UNTIL ?
            initialBooking.nextBookingStartTime : '';
        if (isCurrentBookingActive()) {
            consumePendingRoomOsCheckInForCurrentBooking();
        }

        // A booking already active while initialization is reading RoomOS state
        // may have been checked in before this macro started. Quarantine it before
        // eligibility decision so the short-meeting path cannot re-enable native CheckIn.
        if (isCurrentBookingActive() && !hasRoomOsCheckedInCurrentBooking()) {
            recordCurrentBookingAutocancellationStatus(
                createAutocancellationPolicyDecision(
                    AUTOCANCELLATION_STATUS.BLOCKED,
                    AUTOCANCELLATION_BLOCK_REASON.AWAITING_STARTUP_CHECK_IN
                )
            );
        }
        if (isCurrentBookingActive() &&
            !await evaluateAndApplyCurrentBookingAutocancellationPolicy()) {
            updateReleaseWorkflow();
            return;
        }
        if (isCurrentBookingActive() &&
            !hasRoomOsCheckedInCurrentBooking() &&
            !await quarantineCurrentBookingUntilCheckIn()) {
            updateReleaseWorkflow();
            return;
        }
        if (isCurrentBookingInactive() && !await restoreNativeCheckInWhenNoBooking()) {
            updateReleaseWorkflow();
            return;
        }

        const codecTime = await xapi.Status.Time.SystemTime.get().catch(() => null);
        if (bookingLifecycle.freshness.runtimeStateVersion !== initializationVersion) {
            logger.warn(
                LOG_EVENT.STARTUP,
                '[BookingAutoCancellation] Startup state changed while reading codec time. Revalidating before scheduling health checks or automatic actions.'
            );
            await reconcileStartupAfterEventRace();
            return;
        }
        if (!await scheduleMidnightHealthCheck(codecTime)) {
            updateReleaseWorkflow();
            return;
        }

        scheduleAutomaticCheckIn();

        logger.debug(
            LOG_EVENT.STARTUP,
            `[BookingAutoCancellation] Initial RoomInUse: ${roomInUse} (${bookingLifecycle.presence.roomUseState})`
        );
        logger.debug(
            LOG_EVENT.STARTUP,
            `[BookingAutoCancellation] Initial Booking Status: ${initialBooking.availabilityStatus}`
        );
        logger.debug(
            LOG_EVENT.STARTUP,
            `[BookingAutoCancellation] Initial Current Booking End Time: ${initialBooking.currentBookingEndTime}`
        );
        logger.debug(
            LOG_EVENT.STARTUP,
            `[BookingAutoCancellation] Initial Upcoming Booking Start Time: ${initialBooking.nextBookingStartTime}`
        );
        logger.debug(
            LOG_EVENT.STARTUP,
            `[BookingAutoCancellation] Presence Analytics Supported: ${bookingLifecycle.presence.isRoomUseStatusSupported}`
        );
        
        updateReleaseWorkflow();
    } catch (e) {
        logger.error(
            LOG_EVENT.STARTUP,
            '[BookingAutoCancellation] Setup halted: RoomInUse is unsupported or inactive on this device.',
            { error: e }
        );
        bookingLifecycle.presence.isRoomUseStatusSupported = false;
        bookingLifecycle.presence.roomUseState = ROOM_USE_STATE.UNKNOWN;
        bookingLifecycle.booking.availabilityStatus = undefined;
        bookingLifecycle.booking.currentBookingId = null;
        bookingLifecycle.booking.currentBookingStartTime = '';
        bookingLifecycle.booking.currentBookingEndTime = '';
        bookingLifecycle.booking.nextBookingStartTime = '';
        cancelReleaseTimers();
    } finally {
        isInitializing = false;
    }
}

// ------------------------------------------------------------------------------------------------------------
// --------------------------------------- 14. Logging and Observability ------------------------------------
// ------------------------------------------------------------------------------------------------------------

const LOG_EVENT = Object.freeze({
    CHECKOUT: 'checkout',
    EXTERNAL_CHECKOUT_OBSERVED: 'external_checkout_observed',
    CHECKIN: 'checkin',
    CONFIGURATION: 'configuration',
    HEALTH_CHECK: 'health_check',
    PROMPT: 'prompt',
    RELEASE_WORKFLOW: 'release_workflow',
    READINESS: 'readiness',
    PRESENCE: 'presence',
    AVAILABILITY: 'availability',
    STARTUP: 'startup',
    STALE_STATE: 'stale_state',
    DIAGNOSTIC: 'diagnostic'
});

const LOG_CHANNEL_EVENTS = Object.freeze({
    [LOG_EVENT.CHECKOUT]: true,
    [LOG_EVENT.EXTERNAL_CHECKOUT_OBSERVED]: true
});

const LOG_EVENT_FIELDS = Object.freeze({
    [LOG_EVENT.CHECKOUT]: Object.freeze([
        'source',
        'version',
        'mode',
        'outcome',
        'booking',
        'meetingStart',
        'meetingEnd',
        'reason',
        'status',
        'error'
    ]),
    [LOG_EVENT.EXTERNAL_CHECKOUT_OBSERVED]: Object.freeze([
        'source',
        'version',
        'mode',
        'outcome',
        'booking',
        'meetingStart',
        'meetingEnd',
        'status',
        'error'
    ]),
    [LOG_EVENT.CHECKIN]: Object.freeze([
        'booking',
        'error'
    ]),
    [LOG_EVENT.CONFIGURATION]: Object.freeze([
        'setting',
        'value',
        'error'
    ]),
    [LOG_EVENT.HEALTH_CHECK]: Object.freeze([
        'error'
    ]),
    [LOG_EVENT.PROMPT]: Object.freeze([
        'target',
        'error'
    ]),
    [LOG_EVENT.RELEASE_WORKFLOW]: Object.freeze([
        'booking',
        'reason',
        'error'
    ]),
    [LOG_EVENT.READINESS]: Object.freeze([
        'status',
        'reason',
        'booking',
        'error'
    ]),
    [LOG_EVENT.PRESENCE]: Object.freeze([
        'status',
        'roomUseState',
        'booking',
        'error'
    ]),
    [LOG_EVENT.AVAILABILITY]: Object.freeze([
        'status',
        'timestamp',
        'booking',
        'error'
    ]),
    [LOG_EVENT.STARTUP]: Object.freeze([
        'macro',
        'version',
        'mode',
        'error'
    ]),
    [LOG_EVENT.STALE_STATE]: Object.freeze([
        'booking',
        'error'
    ]),
    [LOG_EVENT.DIAGNOSTIC]: Object.freeze([
        'error'
    ])
});

function formatLogValue(value) {
    return value === null || value === undefined || value === '' ? '(missing)' : value;
}

function formatStructuredLogValue(value) {
    if (value === null || value === undefined || value === '') {
        return '(missing)';
    }
    if (value instanceof Error ||
        (typeof value === 'object' && typeof value.message === 'string')) {
        return formatStructuredLogValue(value.message);
    }
    if (typeof value === 'string') {
        return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return '(unsupported)';
}

function formatLogFields(event, fields) {
    const allowedFields = LOG_EVENT_FIELDS[event] || [];
    const fieldsWithRuntimeVersion = event === LOG_EVENT.CHECKOUT ||
        event === LOG_EVENT.EXTERNAL_CHECKOUT_OBSERVED ?
        Object.assign({}, fields, { version: MACRO_INFO.VERSION }) :
        fields;
    return allowedFields
        .filter(fieldName => fieldsWithRuntimeVersion &&
            Object.prototype.hasOwnProperty.call(fieldsWithRuntimeVersion, fieldName))
        .map(fieldName => `${fieldName}=${formatStructuredLogValue(fieldsWithRuntimeVersion[fieldName])}`)
        .join(' ');
}

function formatLogMessage(event, message, fields) {
    const prefix = '[BookingAutoCancellation]';
    const messageText = String(message);
    const normalizedMessage = messageText.indexOf(prefix) === 0 ? messageText : `${prefix} ${messageText}`;
    const operationName = event === LOG_EVENT.CHECKOUT ||
        event === LOG_EVENT.EXTERNAL_CHECKOUT_OBSERVED ?
        'CHECKOUT' :
        String(event).toUpperCase();
    const fieldText = formatLogFields(event, fields);
    const structuredEvent = `event=${operationName}`;
    return fieldText ? `${normalizedMessage} ${structuredEvent} ${fieldText}` : `${normalizedMessage} ${structuredEvent}`;
}

function emitLog(level, event, message, fields) {
    const output = formatLogMessage(event, message, fields);
    if (level === 'info') {
        if (LOG_CHANNEL_EVENTS[event]) {
            console.log(output);
        } else if (CONFIG.DEBUG) {
            console.debug(output);
        }
        return;
    }
    if (level === 'debug') {
        if (CONFIG.DEBUG) {
            console.debug(output);
        }
        return;
    }
    if (level === 'warn') {
        console.warn(output);
        return;
    }
    if (level === 'error') {
        console.error(output);
    }
}

const logger = Object.freeze({
    info: (event, message, fields) => emitLog('info', event, message, fields),
    debug: (event, message, fields) => emitLog('debug', event, message, fields),
    warn: (event, message, fields) => emitLog('warn', event, message, fields),
    error: (event, message, fields) => emitLog('error', event, message, fields)
});

if (typeof AUTO_RELEASE_BOOKING_TEST_MODE === 'undefined') {
    init();
}