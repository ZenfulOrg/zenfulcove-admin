// ─── Default Automation Config ──────────────────────────────────────────────
// This file is the SEED for Upstash KV on first run.
// After that, all values are read/written from KV via the dashboard.
// To change defaults for a fresh deploy, edit here.
//
// ALL configurable IDs and values live in this single file.
// ────────────────────────────────────────────────────────────────────────────

export const automationConfig = {
  sendgrid: {
    fromEmail: "contact@zenfulcove.com",
    fromName: "Zenfulcove Glamping",
    sendgridContactListId: "65075b7e-7fd3-4357-9953-6ff3ce2ff59b", // "Lodgify Booked Guests" — shared by all automations
    // Numeric Advanced Suppression Manager group for promotional emails.
    // Transactional waiver/access-code messages intentionally do not use it.
    marketingUnsubscribeGroupId: "",
  },
  vacancyEmails: {
    enabled: true,
    windows: [
      {
        daysBeforeCheckin: 7,
        templateId: "d-REPLACE_ME_7DAY", // SendGrid dynamic template for 7-day promo
        expiresDaysBeforeCheckin: 1,
        expiresAtLocalTime: "11:59 PM",
        expirationTimezone: "America/Chicago",
      },
      {
        daysBeforeCheckin: 4,
        templateId: "d-REPLACE_ME_4DAY", // SendGrid dynamic template for 4-day promo
        expiresDaysBeforeCheckin: 1,
        expiresAtLocalTime: "11:59 PM",
        expirationTimezone: "America/Chicago",
      },
    ],
  },
  waiverReminders: {
    enabled: true,
    propertyIds: [], // Lodgify property IDs to restrict to (e.g. Zenfulcove Glamping only). Empty = all properties.
    formSource: "internal", // "internal" posts Lodgify messages with the internal form link. "jotform" sends legacy SendGrid templates.
    localFormSlug: "welcome-to-zenfulcove", // Internal Zenfulcove Glamping form slug. Used only when formSource is "internal".
    jotformFormId: "251834442091050", // Legacy Jotform waiver form ID fallback during migration.
    emails: [
      // Legacy Jotform uses templateId. Internal form mode uses the Lodgify subject/message fields.
      { daysBeforeCheckin: 2, templateId: "d-REPLACE_ME_JOTFORM_2DAY", subjectTemplate: "Reservation form needed for {{propertyDisplayName}}", messageTemplate: "", label: "Reminder 1" },
      { daysBeforeCheckin: 1, templateId: "d-REPLACE_ME_JOTFORM_1DAY", subjectTemplate: "Reservation form needed for {{propertyDisplayName}}", messageTemplate: "", label: "Reminder 2" },
      { daysBeforeCheckin: 0, templateId: "d-REPLACE_ME_JOTFORM_0DAY", subjectTemplate: "Reservation form needed for {{propertyDisplayName}}", messageTemplate: "", label: "Reminder 3" },
    ],
  },
  accessCodeRelease: {
    enabled: false,
    waiverLodgifyScheduleVersion: 2,
    deliveryChannel: "lodgify",
    releaseHourCentral: 15,
    releaseMinuteCentral: 0,
    releaseDaysBeforeCheckin: 1, // 1 = day before arrival.
    immediateReleaseDaysBeforeCheckin: 1, // Today releases immediately. Tomorrow releases immediately after the 3 PM release threshold.
    dayOfCodeReleaseHourCentral: 11,
    dayOfCodeReleaseMinuteCentral: 0,
    delayedAccessCodePropertyNames: ["Doodle House", "Desert Rose"],
    delayedAccessCodePropertyIds: [],
    sendgridTemplateId: "", // Legacy only. Access-code delivery now posts to Lodgify booking messages.
    missingFormTemplateId: "", // Legacy only. Missing-form delivery now posts to Lodgify booking messages.
    accessCodeSubjectTemplate: "Access Code for {{propertyDisplayName}}",
    checkinInfoSubjectTemplate: "Check-in information for {{propertyDisplayName}}",
    codeOnlySubjectTemplate: "Access code for {{propertyDisplayName}}",
    missingFormSubjectTemplate: "Reservation form needed for {{propertyDisplayName}}",
    accessCodeMessageTemplate: "",
    checkinInfoMessageTemplate: "",
    codeOnlyMessageTemplate:
      "Greetings {{GuestFirstName}},\n\nYour access code for {{propertyDisplayName}} is {{KeyCode}}.\n\nThis code will only work during your reservation time.",
    missingFormMessageTemplate: "",
    lodgifyMessageType: "Owner",
    lodgifySendNotification: true,
    lodgifyPlainTextSources: ["BookingCom"], // Source keys that should avoid Lodgify HTML formatting.
    lodgifyMaskedLinkSources: [], // Source keys that should receive readable, non-clickable URLs.
    lodgifyEmailFallbackSources: ["GlampingHub", "Glamping Hub"], // Source keys that need a SendGrid backup; Lodgify is still used when a thread exists.
    lodgifyRouteRequiredSources: ["AirbnbIntegration", "Airbnb", "BookingCom"], // Verify Lodgify API posts route to the channel thread; otherwise use email fallback.
    localFormSlug: "welcome-to-zenfulcove",
    jotformFormId: "251834442091050", // fallback while historical Jotform forms are still active
    propertyIds: [],
    includeCancelledBookings: false,
    propertyCodes: {},
    jervisApiBaseUrl: "https://www.jervis.systems/api/v1",
    jervisAccountUuid: "6a08e49c-a62d-53e0-bba5-20121b2456e4",
    jervisPropertyIds: {},
    jervisAccessStartTime: "15:00:00",
    jervisAccessEndTime: "11:00:00",
    accessWindowOverrides: [
      // Men's retreat, Nov 4–8 2026: codes work from 11 AM on arrival day.
      { checkinDate: "2026-11-04", accessStartTime: "11:00:00", checkinTimeLabel: "11:00 a.m." },
    ],
    propertyMessageData: {
      "Sky Castle": {
        displayName: "SKY CASTLE",
        directionsName: "SKY CASTLE",
        address: "103 potato smith rd, unit c, elgin texas 78621",
        googleMapsAddress: "103 potato smith rd, unit c, elgin texas 78621",
        googleMapsUrl: "https://maps.app.goo.gl/QowaHLFH3anBavuv6?g_st=ic",
        parkingInstructions:
          "Parking - please park in front of your unit on the white gravel driveway.",
        wifiName: "SKYCASTLE",
        wifiPassword: "Iamgrateful!",
        dedicatedKayakText:
          "There is one Dedicated Kayak for Sky Castle guests exclusive enjoyment and located hanging up on a rack on the side of the pond close to the house, it is labeled with the words, Sky Castle. The kayak lock code is 1010.",
        amenitiesText:
          "If you have any questions, please let me know. I have left a journal in the unit as a gift to you. There is a gas grill on the deck for grilling, an outdoor soaking tub, private beach access, and 1 kayak for your enjoyment.",
      },
    },
    jervisAccessCodeApiUrl: "",
  },
  popupFollowups: {
    enabled: false,
    channelMode: "email",
    sendgridContactListId: "44b5b3f5-d03d-4552-997f-8715a906d5b8",
    excludeBookedGuests: true,
    // Blank falls back to sendgrid.sendgridContactListId (Lodgify Booked Guests).
    bookedGuestsListId: "",
    popupTriggeredFieldId: "popup_triggered_at",
    popupSentTemplatesFieldId: "popup_sent_templates",
    popupSentSmsFieldId: "popup_sent_sms",
    // Must match SENDGRID_POPUP_SMS_CONSENT_FIELD_ID in zenfulcove-site.
    // Real-contact SMS is fail-closed until this field is configured and says yes.
    popupSmsConsentFieldId: "",
    testDestinations: {
      email: "",
      sms: "",
    },
    emails: [
      { daysAfterTrigger: 2, templateId: "", label: "Follow-up (2 days after)" },
      { daysAfterTrigger: 3, templateId: "", label: "Follow-up (3 days after)" },
      { daysAfterTrigger: 6, templateId: "", label: "Follow-up (6 days after)" },
    ],
    sms: [
      { daysAfterTrigger: 2, messageKey: "sms_day_2", label: "SMS (2 days after)", messageBody: "", enabled: true },
      { daysAfterTrigger: 3, messageKey: "sms_day_3", label: "SMS (3 days after)", messageBody: "", enabled: true },
      { daysAfterTrigger: 6, messageKey: "sms_day_6", label: "SMS (6 days after)", messageBody: "", enabled: true },
    ],
  },
  eventPopupSalesmateSms: {
    enabled: false,
    syncToSalesmate: true,
    sendgridContactListId: "dc7aeb0a-c70c-4c6e-a1cd-b0c8c2b93cb8",
    triggerDateFieldId: "",
    twilioFromNumber: "",
    salesmateLeadSource: "Website",
    salesmateTags: ["admin portal", "event popup"],
    testDestinations: {
      sms: "",
    },
    sms: [
      {
        id: "event_popup_sms_day_0",
        daysAfterTrigger: 0,
        messageBody: "",
        enabled: true,
      },
    ],
  },
  jotformClientSync: {
    enabled: false,
    sendgridContactListId: "e46aa43e-3f91-4965-8bbb-fcae8f9c3124",
    jotformFormIds: ["251834442091050"],
  },
  localFormClientSync: {
    enabled: false,
    sendgridContactListId: "e46aa43e-3f91-4965-8bbb-fcae8f9c3124",
    formSlugs: ["welcome-to-zenfulcove"],
    onlyUnsynced: false,
  },
  jotformLocalFormImport: {
    enabled: false,
    mappings: [
      {
        jotformFormId: "251834442091050",
        localFormSlug: "welcome-to-zenfulcove",
      },
    ],
    limit: 1000,
  },
  lodgifyClientSync: {
    enabled: false,
    sendgridContactListId: "e46aa43e-3f91-4965-8bbb-fcae8f9c3124",
    stayDateLookbackDays: 30,
    stayDateLookaheadDays: 365,
    includeCancelledBookings: true,
  },
  // Always-on daily sweep that mirrors a SINGLE master SendGrid list into
  // Salesmate. For each contact in `sourceListId`, tags are derived from every
  // *other* SendGrid list the contact also belongs to (using SendGrid's
  // `list_ids` field on each contact), so a single Salesmate write per contact
  // captures every form they came from. Re-syncs only when the derived tag set
  // changes for that contact.
  salesmateFormSync: {
    enabled: true,
    leadSource: "Website",
    // The master list (default = "All Clients"). Every contact in this list is
    // mirrored into Salesmate.
    sourceListId: "e46aa43e-3f91-4965-8bbb-fcae8f9c3124",
  },
  // Real-time email alert when an inbound SMS is received at any Twilio
  // number. Fires from the Twilio inbound webhook, so latency is whatever
  // SendGrid takes (typically <1s). Recipients can be one or many.
  messageNotifications: {
    enabled: true,
    recipients: ["contact@zenfulcove.com"],
    subjectPrefix: "[Zenfulcove Glamping SMS]",
    // Base URL of the admin dashboard. Used to deep-link the alert email
    // straight to the messages tab + thread. Falls back to
    // NEXT_PUBLIC_DASHBOARD_URL env var if blank.
    dashboardUrl: "",
  },
  spaSettings: {
    // Master weekly window Zenfulcove accepts in-cabin massage bookings.
    // Bookable times = this range ∩ each therapist's own hours, minus their
    // calendar's busy blocks. Anything outside this is never offered.
    masterHours: {
      "0": [["09:00", "20:00"]],
      "1": [["09:00", "20:00"]],
      "2": [["09:00", "20:00"]],
      "3": [["09:00", "20:00"]],
      "4": [["09:00", "20:00"]],
      "5": [["09:00", "20:00"]],
      "6": [["09:00", "20:00"]],
    },
  },
  customerPortal: {
    navigation: {
      rentals: true,
      messages: false,
      availability: true,
      packages: true,
      spa: false,
      timing: true,
      forms: true,
      terms: true,
    },
    myStaySections: {
      thingsToDoInElgin: {
        enabled: true,
        eyebrow: "Local Guide",
        title: "Things To Do In Elgin",
        body: "Explore Elgin dining, shopping, parks, events, arts, and history during your stay.",
        linkLabel: "Visit Guide",
        linkUrl: "https://www.elgintexas.gov/1251/Visit-Elgin",
      },
      elginSpotlight: {
        enabled: true,
        eyebrow: "Around Town",
        title: "Elgin Spotlight",
        body: "Start with historic downtown for local food, shops, art, and small-town stops close to Zenfulcove.",
        linkLabel: "Explore",
        linkUrl: "https://www.elgintexas.gov/196/Explore-Elgin",
      },
    },
  },
  eventPortal: {
    enabled: true,
    waiverFormSlug: "welcome-to-zenfulcove",
    events: [],
  },
};
