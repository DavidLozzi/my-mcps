// mac-helper: a thin JSON bridge between the Node MCP server and EventKit.
//
// Usage: mac-helper <command>   (JSON arguments on stdin, JSON result on stdout)
//
// Every response is a single line: {"ok":true,"data":...} or
// {"ok":false,"code":"...","message":"..."}. The process always exits 0 once it
// has written a response, so a non-zero exit means the helper itself crashed.
//
// Filtering, sorting, and presentation live in the Node server where they can be
// tested without Reminders or Calendar access. This file only reads and writes
// the store.

import CoreGraphics
import EventKit
import Foundation

struct HelperError: Error {
    let code: String
    let message: String
}

let store = EKEventStore()
let calendar = Calendar.current

// MARK: - Plumbing

func respond(_ payload: [String: Any]) -> Never {
    let data: Data
    if let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
        data = encoded
    } else {
        data = Data(#"{"ok":false,"code":"internal","message":"Could not encode the helper response."}"#.utf8)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

/// EventKit reports results on a private queue. Hop back to main and spin the
/// run loop until the callback lands, so the rest of the helper stays linear.
func wait<T>(_ start: (@escaping (T) -> Void) -> Void) -> T {
    var result: T?
    start { value in
        DispatchQueue.main.async { result = value }
    }
    while result == nil {
        RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    return result!
}

func invalid(_ message: String) -> HelperError {
    HelperError(code: "invalid_input", message: message)
}

// MARK: - Access

func statusName(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .fullAccess: return "full_access"
    case .writeOnly: return "write_only"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
}

func entityName(_ type: EKEntityType) -> String {
    type == .event ? "Calendar" : "Reminders"
}

/// Reminders and Calendar are separate permissions, each asked for the first
/// time a command needs it. Denial messages lead with the entity name so the
/// server can point at the right settings pane.
func requireAccess(_ type: EKEntityType) throws {
    let status = EKEventStore.authorizationStatus(for: type)
    switch status {
    case .fullAccess:
        return
    case .notDetermined:
        let (granted, error): (Bool, Error?) = wait { done in
            if type == .event {
                store.requestFullAccessToEvents { granted, error in done((granted, error)) }
            } else {
                store.requestFullAccessToReminders { granted, error in done((granted, error)) }
            }
        }
        if granted { return }
        let reason = error.map { ": \($0.localizedDescription)" } ?? "."
        throw HelperError(code: "access_denied", message: "\(entityName(type)) access was not granted\(reason)")
    default:
        throw HelperError(code: "access_denied", message: "\(entityName(type)) access is \(statusName(status)).")
    }
}

func accessSummary() -> [String: Any] {
    [
        "reminders": statusName(EKEventStore.authorizationStatus(for: .reminder)),
        "calendar": statusName(EKEventStore.authorizationStatus(for: .event)),
    ]
}

// MARK: - Dates

let stampFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd'T'HH:mm"
    return f
}()

func stamp(_ date: Date) -> String {
    stampFormatter.string(from: date)
}

/// Parses `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM[:SS]` (local time) into
/// the components EventKit stores. An all-day due date deliberately carries no
/// hour, which is how the Reminders app tells the two apart.
func parseDue(_ text: String) throws -> DateComponents {
    let halves = text.split(separator: "T", omittingEmptySubsequences: false)
    guard halves.count <= 2 else { throw invalid("Unrecognised date \"\(text)\".") }

    let day = halves[0].split(separator: "-").compactMap { Int($0) }
    guard day.count == 3 else {
        throw invalid("Unrecognised date \"\(text)\". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.")
    }

    var components = DateComponents(year: day[0], month: day[1], day: day[2])
    if halves.count == 2 {
        let time = halves[1].split(separator: ":").compactMap { Int($0) }
        guard time.count == 2 || time.count == 3 else {
            throw invalid("Unrecognised time in \"\(text)\". Use HH:MM.")
        }
        components.hour = time[0]
        components.minute = time[1]
        components.timeZone = TimeZone.current
    }

    // Round-trip to reject dates like 2026-02-30 that Calendar would roll over.
    guard let resolved = calendar.date(from: components) else { throw invalid("Invalid date \"\(text)\".") }
    let back = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: resolved)
    guard back.year == day[0], back.month == day[1], back.day == day[2],
          components.hour == nil || (back.hour == components.hour && back.minute == components.minute)
    else {
        throw invalid("Invalid date \"\(text)\".")
    }
    return components
}

func parseInstant(_ text: String) throws -> Date {
    var components = try parseDue(text)
    if components.hour == nil {
        components.hour = 0
        components.minute = 0
    }
    guard let date = calendar.date(from: components) else { throw invalid("Invalid date \"\(text)\".") }
    return date
}

func isTimed(_ components: DateComponents?) -> Bool {
    components?.hour != nil
}

func instant(_ components: DateComponents) -> Date? {
    var c = components
    if c.calendar == nil { c.calendar = calendar }
    return c.date
}

func formatComponents(_ components: DateComponents) -> String? {
    if !isTimed(components) {
        guard let y = components.year, let m = components.month, let d = components.day else { return nil }
        return String(format: "%04d-%02d-%02d", y, m, d)
    }
    return instant(components).map(stamp)
}

// MARK: - Serialisation

func priorityName(_ value: Int) -> String {
    switch value {
    case 1...4: return "high"
    case 5: return "medium"
    case 6...9: return "low"
    default: return "none"
    }
}

func priorityValue(_ name: String) throws -> Int {
    switch name {
    case "none": return 0
    case "high": return 1
    case "medium": return 5
    case "low": return 9
    default: throw invalid("Unknown priority \"\(name)\". Use none, low, medium, or high.")
    }
}

func frequencyName(_ frequency: EKRecurrenceFrequency) -> String {
    switch frequency {
    case .daily: return "daily"
    case .weekly: return "weekly"
    case .monthly: return "monthly"
    case .yearly: return "yearly"
    @unknown default: return "unknown"
    }
}

func serializeAlarm(_ alarm: EKAlarm) -> [String: Any] {
    if let location = alarm.structuredLocation {
        let proximity: String
        switch alarm.proximity {
        case .enter: proximity = "arriving"
        case .leave: proximity = "leaving"
        default: proximity = "none"
        }
        return ["type": "location", "title": location.title ?? "", "proximity": proximity]
    }
    if let date = alarm.absoluteDate {
        return ["type": "absolute", "at": stamp(date)]
    }
    return ["type": "relative", "minutesBefore": Int((-alarm.relativeOffset / 60).rounded())]
}

let weekdayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

func serializeRule(_ rule: EKRecurrenceRule) -> [String: Any] {
    var out: [String: Any] = ["frequency": frequencyName(rule.frequency), "interval": rule.interval]
    // "Every Mon, Wed" on a weekly rule round-trips; anything subtler does not.
    let days = rule.daysOfTheWeek ?? []
    let plainWeekdays = rule.frequency == .weekly && !days.isEmpty && days.allSatisfy { $0.weekNumber == 0 }
    if plainWeekdays {
        out["daysOfWeek"] = days.map { weekdayNames[$0.dayOfTheWeek.rawValue - 1] }
    }
    if let end = rule.recurrenceEnd {
        if let date = end.endDate {
            out["until"] = stamp(date)
        } else if end.occurrenceCount > 0 {
            out["count"] = end.occurrenceCount
        }
    }
    // Rules built in the Reminders app ("every weekday", "last Friday") carry
    // extra constraints this server cannot round-trip. Flag them so an update
    // does not silently flatten one into a plain interval.
    let custom = (!days.isEmpty && !plainWeekdays) || !(rule.daysOfTheMonth ?? []).isEmpty
        || !(rule.monthsOfTheYear ?? []).isEmpty || !(rule.weeksOfTheYear ?? []).isEmpty
        || !(rule.daysOfTheYear ?? []).isEmpty || !(rule.setPositions ?? []).isEmpty
    if custom { out["custom"] = true }
    return out
}

func serialize(_ reminder: EKReminder) -> [String: Any] {
    var out: [String: Any] = [
        "id": reminder.calendarItemIdentifier,
        "title": reminder.title ?? "",
        "list": reminder.calendar?.title ?? "",
        "listId": reminder.calendar?.calendarIdentifier ?? "",
        "completed": reminder.isCompleted,
        "priority": priorityName(reminder.priority),
        "alarms": (reminder.alarms ?? []).map(serializeAlarm),
    ]
    out["notes"] = reminder.notes ?? NSNull()
    out["url"] = reminder.url?.absoluteString ?? NSNull()
    out["due"] = reminder.dueDateComponents.flatMap(formatComponents) ?? NSNull()
    out["completedAt"] = reminder.completionDate.map(stamp) ?? NSNull()
    out["created"] = reminder.creationDate.map(stamp) ?? NSNull()
    out["modified"] = reminder.lastModifiedDate.map(stamp) ?? NSNull()
    out["recurrence"] = reminder.recurrenceRules?.first.map(serializeRule) ?? NSNull()
    return out
}

// MARK: - Lookup

func reminderLists() -> [EKCalendar] {
    store.calendars(for: .reminder)
}

func describeList(_ list: EKCalendar) -> String {
    "\"\(list.title)\" (\(list.source?.title ?? "unknown account"), id \(list.calendarIdentifier))"
}

/// Reminder lists and calendars are both EKCalendars; only the vocabulary in
/// the errors differs.
func resolveCalendar(_ reference: String, for type: EKEntityType) throws -> EKCalendar {
    let (noun, plural, code) = type == .event
        ? ("calendar", "calendars", "calendar")
        : ("reminder list", "lists", "list")
    let all = store.calendars(for: type)
    if let exact = all.first(where: { $0.calendarIdentifier == reference }) {
        return exact
    }

    let wanted = reference.trimmingCharacters(in: .whitespaces)
    let matches = all.filter { $0.title.caseInsensitiveCompare(wanted) == .orderedSame }
    if matches.count == 1 { return matches[0] }

    if matches.isEmpty {
        let names = all.map { "\"\($0.title)\"" }.joined(separator: ", ")
        throw HelperError(
            code: "\(code)_not_found",
            message: "No \(noun) named \"\(reference)\". \(plural.capitalized): \(names)."
        )
    }
    let options = matches.map(describeList).joined(separator: "; ")
    throw HelperError(
        code: "ambiguous_\(code)",
        message: "\(matches.count) \(plural) are named \"\(reference)\": \(options). Pass the \(code) id instead."
    )
}

func resolveList(_ reference: String) throws -> EKCalendar {
    try resolveCalendar(reference, for: .reminder)
}

func findReminder(_ id: String) -> EKReminder? {
    store.calendarItem(withIdentifier: id) as? EKReminder
}

func requireReminder(_ id: String) throws -> EKReminder {
    guard let reminder = findReminder(id) else {
        throw HelperError(code: "not_found", message: "No reminder with id \(id).")
    }
    return reminder
}

func fetch(_ predicate: NSPredicate) -> [EKReminder] {
    wait { done in
        _ = store.fetchReminders(matching: predicate) { done($0 ?? []) }
    }
}

// MARK: - Field application

func stringArray(_ value: Any?, _ field: String) throws -> [String] {
    guard let items = value as? [Any] else { throw invalid("\(field) must be an array of strings.") }
    return try items.map {
        guard let s = $0 as? String else { throw invalid("\(field) must be an array of strings.") }
        return s
    }
}

func buildAlarms(_ value: Any?) throws -> [EKAlarm] {
    guard let items = value as? [[String: Any]] else {
        throw invalid("alarms must be an array of {at} or {minutesBefore} objects.")
    }
    return try items.map { item in
        if let at = item["at"] as? String {
            return EKAlarm(absoluteDate: try parseInstant(at))
        }
        if let minutes = item["minutesBefore"] as? Int {
            return EKAlarm(relativeOffset: TimeInterval(-minutes * 60))
        }
        throw invalid("Each alarm needs either \"at\" or \"minutesBefore\".")
    }
}

func buildRule(_ value: [String: Any]) throws -> EKRecurrenceRule {
    let frequency: EKRecurrenceFrequency
    switch value["frequency"] as? String {
    case "daily": frequency = .daily
    case "weekly": frequency = .weekly
    case "monthly": frequency = .monthly
    case "yearly": frequency = .yearly
    default: throw invalid("recurrence.frequency must be daily, weekly, monthly, or yearly.")
    }
    let interval = value["interval"] as? Int ?? 1
    guard interval >= 1 else { throw invalid("recurrence.interval must be at least 1.") }

    var end: EKRecurrenceEnd?
    if let until = value["until"] as? String {
        end = EKRecurrenceEnd(end: try parseInstant(until))
    } else if let count = value["count"] as? Int {
        end = EKRecurrenceEnd(occurrenceCount: count)
    }

    var weekdays: [EKRecurrenceDayOfWeek]?
    if let names = value["daysOfWeek"] {
        guard frequency == .weekly else { throw invalid("recurrence.daysOfWeek only applies to a weekly repeat.") }
        weekdays = try stringArray(names, "recurrence.daysOfWeek").map { name in
            guard let index = weekdayNames.firstIndex(of: name.lowercased()), let day = EKWeekday(rawValue: index + 1)
            else {
                throw invalid("Unknown weekday \"\(name)\". Use sun, mon, tue, wed, thu, fri, or sat.")
            }
            return EKRecurrenceDayOfWeek(day)
        }
        if weekdays!.isEmpty { weekdays = nil }
    }
    return EKRecurrenceRule(
        recurrenceWith: frequency, interval: interval, daysOfTheWeek: weekdays, daysOfTheMonth: nil,
        monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: end
    )
}

/// Applies a patch. A key that is absent leaves the field alone; a key set to
/// null clears it. That distinction is why fields arrive as [String: Any]
/// rather than a Codable struct.
func apply(_ fields: [String: Any], to reminder: EKReminder) throws {
    if let title = fields["title"] as? String {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw invalid("title cannot be empty.")
        }
        reminder.title = title
    }

    if let list = fields["list"] as? String {
        let target = try resolveList(list)
        guard target.allowsContentModifications else {
            throw HelperError(code: "read_only", message: "The list \(describeList(target)) is read-only.")
        }
        reminder.calendar = target
    }

    if fields.keys.contains("notes") {
        reminder.notes = fields["notes"] as? String
    }

    if fields.keys.contains("url") {
        if let text = fields["url"] as? String {
            guard let url = URL(string: text), url.scheme != nil else { throw invalid("Invalid url \"\(text)\".") }
            reminder.url = url
        } else {
            reminder.url = nil
        }
    }

    if let priority = fields["priority"] as? String {
        reminder.priority = try priorityValue(priority)
    }

    if fields.keys.contains("due") {
        let oldDue = reminder.dueDateComponents.flatMap { isTimed($0) ? instant($0) : nil }
        if let text = fields["due"] as? String {
            reminder.dueDateComponents = try parseDue(text)
        } else {
            reminder.dueDateComponents = nil
        }

        // The Reminders app notifies at the due time whenever a time is set.
        // Mirror that: move the alarm that tracked the old due time, and add
        // one for a newly timed due date, unless the caller set alarms itself.
        if !fields.keys.contains("alarms") {
            var alarms = reminder.alarms ?? []
            if let oldDue {
                alarms.removeAll { $0.absoluteDate == oldDue }
            }
            if isTimed(reminder.dueDateComponents), let newDue = instant(reminder.dueDateComponents!),
               !alarms.contains(where: { $0.absoluteDate == newDue })
            {
                alarms.append(EKAlarm(absoluteDate: newDue))
            }
            reminder.alarms = alarms
        }
    }

    if fields.keys.contains("alarms") {
        // Location alarms cannot be created here, so replacing the set keeps them.
        let kept = (reminder.alarms ?? []).filter { $0.structuredLocation != nil }
        let fresh = fields["alarms"] is NSNull ? [] : try buildAlarms(fields["alarms"])
        reminder.alarms = kept + fresh
    }

    if fields.keys.contains("recurrence") {
        if let rule = fields["recurrence"] as? [String: Any] {
            reminder.recurrenceRules = [try buildRule(rule)]
        } else {
            reminder.recurrenceRules = nil
        }
    }

    if !(reminder.recurrenceRules ?? []).isEmpty && reminder.dueDateComponents == nil {
        throw invalid("A repeating reminder needs a due date.")
    }
}

// MARK: - Commands

func commandLists() -> Any {
    let open = fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil))
    var counts: [String: Int] = [:]
    for reminder in open {
        counts[reminder.calendar.calendarIdentifier, default: 0] += 1
    }
    let defaultId = store.defaultCalendarForNewReminders()?.calendarIdentifier

    return reminderLists().map { list -> [String: Any] in
        [
            "id": list.calendarIdentifier,
            "title": list.title,
            "account": list.source?.title ?? "",
            "openCount": counts[list.calendarIdentifier] ?? 0,
            "isDefault": list.calendarIdentifier == defaultId,
            "readOnly": !list.allowsContentModifications,
        ]
    }
}

func commandFetch(_ input: [String: Any]) throws -> Any {
    let lists: [EKCalendar]? = try input["lists"].map { try stringArray($0, "lists").map(resolveList) }
    let status = input["status"] as? String ?? "incomplete"
    guard ["incomplete", "completed", "all"].contains(status) else {
        throw invalid("status must be incomplete, completed, or all.")
    }

    var found: [EKReminder] = []
    if status != "completed" {
        found += fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists))
    }
    if status != "incomplete" {
        let after = try (input["completedAfter"] as? String).map(parseInstant)
        let before = try (input["completedBefore"] as? String).map(parseInstant)
        found += fetch(store.predicateForCompletedReminders(
            withCompletionDateStarting: after, ending: before, calendars: lists
        ))
    }
    return found.map(serialize)
}

func commandGet(_ input: [String: Any]) throws -> Any {
    guard let id = input["id"] as? String else { throw invalid("id is required.") }
    return serialize(try requireReminder(id))
}

func commandCreate(_ input: [String: Any]) throws -> Any {
    guard let title = input["title"] as? String else { throw invalid("title is required.") }

    let reminder = EKReminder(eventStore: store)
    guard let fallback = store.defaultCalendarForNewReminders() else {
        throw HelperError(code: "list_not_found", message: "There is no default reminder list. Pass a list.")
    }
    reminder.calendar = fallback
    reminder.title = title

    var fields = input
    fields.removeValue(forKey: "title")
    try apply(fields, to: reminder)
    try store.save(reminder, commit: true)
    return serialize(reminder)
}

func commandUpdate(_ input: [String: Any]) throws -> Any {
    guard let id = input["id"] as? String else { throw invalid("id is required.") }
    let reminder = try requireReminder(id)
    var fields = input
    fields.removeValue(forKey: "id")
    try apply(fields, to: reminder)
    try store.save(reminder, commit: true)
    return serialize(reminder)
}

/// Batch commands resolve every id before touching anything, so one bad id
/// fails the call without leaving half the batch applied.
func commandSetCompleted(_ input: [String: Any]) throws -> Any {
    let ids = try stringArray(input["ids"], "ids")
    guard let completed = input["completed"] as? Bool else { throw invalid("completed is required.") }
    let reminders = try ids.map(requireReminder)

    for reminder in reminders {
        reminder.isCompleted = completed
        try store.save(reminder, commit: false)
    }
    try store.commit()
    return reminders.map(serialize)
}

func commandDelete(_ input: [String: Any]) throws -> Any {
    let ids = try stringArray(input["ids"], "ids")
    let reminders = try ids.map(requireReminder)
    let snapshot = reminders.map(serialize)

    for reminder in reminders {
        try store.remove(reminder, commit: false)
    }
    try store.commit()
    return snapshot
}

func commandCreateList(_ input: [String: Any]) throws -> Any {
    guard let title = input["title"] as? String,
          !title.trimmingCharacters(in: .whitespaces).isEmpty
    else {
        throw invalid("title is required.")
    }

    let source: EKSource
    if let account = input["account"] as? String {
        let candidates = store.sources.filter {
            $0.title.caseInsensitiveCompare(account) == .orderedSame && !$0.calendars(for: .reminder).isEmpty
        }
        guard let match = candidates.first else {
            let names = Set(reminderLists().compactMap { $0.source?.title }).sorted().joined(separator: ", ")
            throw HelperError(code: "account_not_found", message: "No reminders account named \"\(account)\". Accounts: \(names).")
        }
        source = match
    } else {
        guard let fallback = store.defaultCalendarForNewReminders()?.source else {
            throw HelperError(code: "account_not_found", message: "There is no default reminders account. Pass an account.")
        }
        source = fallback
    }

    let list = EKCalendar(for: .reminder, eventStore: store)
    list.title = title
    list.source = source
    try store.saveCalendar(list, commit: true)
    return ["id": list.calendarIdentifier, "title": list.title, "account": source.title]
}

// MARK: - Calendar: serialisation

func colorHex(_ color: CGColor?) -> String? {
    guard let color, let srgb = CGColorSpace(name: CGColorSpace.sRGB),
          let c = color.converted(to: srgb, intent: .defaultIntent, options: nil)?.components, c.count >= 3
    else { return nil }
    return String(format: "#%02X%02X%02X", Int((c[0] * 255).rounded()), Int((c[1] * 255).rounded()), Int((c[2] * 255).rounded()))
}

func parseColor(_ text: String) throws -> CGColor {
    var hex = text.trimmingCharacters(in: .whitespaces)
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, let value = UInt32(hex, radix: 16) else {
        throw invalid("color must be a hex value like #FF9500.")
    }
    return CGColor(
        srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
        blue: CGFloat(value & 0xFF) / 255, alpha: 1
    )
}

func calendarTypeName(_ type: EKCalendarType) -> String {
    switch type {
    case .local: return "local"
    case .calDAV: return "caldav"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "unknown"
    }
}

func availabilityName(_ value: EKEventAvailability) -> String {
    switch value {
    case .busy: return "busy"
    case .free: return "free"
    case .tentative: return "tentative"
    case .unavailable: return "unavailable"
    default: return "not_supported"
    }
}

func availabilityValue(_ name: String) throws -> EKEventAvailability {
    switch name {
    case "busy": return .busy
    case "free": return .free
    case "tentative": return .tentative
    case "unavailable": return .unavailable
    default: throw invalid("Unknown availability \"\(name)\". Use busy, free, tentative, or unavailable.")
    }
}

func eventStatusName(_ value: EKEventStatus) -> String {
    switch value {
    case .confirmed: return "confirmed"
    case .tentative: return "tentative"
    case .canceled: return "canceled"
    default: return "none"
    }
}

func participantStatusName(_ value: EKParticipantStatus) -> String {
    switch value {
    case .pending: return "pending"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "in_process"
    default: return "unknown"
    }
}

func participantRoleName(_ value: EKParticipantRole) -> String {
    switch value {
    case .required: return "required"
    case .optional: return "optional"
    case .chair: return "chair"
    case .nonParticipant: return "non_participant"
    default: return "unknown"
    }
}

func participantTypeName(_ value: EKParticipantType) -> String {
    switch value {
    case .person: return "person"
    case .room: return "room"
    case .resource: return "resource"
    case .group: return "group"
    default: return "unknown"
    }
}

func serializeParticipant(_ participant: EKParticipant) -> [String: Any] {
    let address = participant.url.absoluteString
    let email = address.lowercased().hasPrefix("mailto:") ? String(address.dropFirst("mailto:".count)) : nil
    var out: [String: Any] = [
        "name": participant.name ?? "",
        "status": participantStatusName(participant.participantStatus),
        "role": participantRoleName(participant.participantRole),
        "type": participantTypeName(participant.participantType),
        "isMe": participant.isCurrentUser,
    ]
    out["email"] = email ?? NSNull()
    return out
}

func dayString(_ date: Date) -> String {
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
}

/// Every occurrence of a repeating event shares one eventIdentifier, so the id
/// handed out appends the occurrence's original start. Without it an edit meant
/// for next Tuesday would land on the first meeting of the series.
func occurrenceKey(_ event: EKEvent) -> String? {
    guard event.hasRecurrenceRules || event.isDetached else { return nil }
    return stamp(event.occurrenceDate ?? event.startDate)
}

func eventId(_ event: EKEvent) -> String {
    let base: String = event.eventIdentifier ?? event.calendarItemIdentifier
    return occurrenceKey(event).map { "\(base)::\($0)" } ?? base
}

func serializeEvent(_ event: EKEvent) -> [String: Any] {
    var out: [String: Any] = [
        "id": eventId(event),
        "title": event.title ?? "",
        "calendar": event.calendar?.title ?? "",
        "calendarId": event.calendar?.calendarIdentifier ?? "",
        "allDay": event.isAllDay,
        "availability": availabilityName(event.availability),
        "status": eventStatusName(event.status),
        "recurring": event.hasRecurrenceRules,
        "detached": event.isDetached,
        "alarms": (event.alarms ?? []).map(serializeAlarm),
        "attendees": (event.attendees ?? []).map(serializeParticipant),
        "readOnly": !(event.calendar?.allowsContentModifications ?? false),
    ]
    if event.isAllDay {
        // All-day ends are stored as the last moment of the final day (or the
        // next midnight); either way the inclusive last day is one second back.
        out["start"] = dayString(event.startDate)
        out["end"] = dayString(event.endDate > event.startDate ? event.endDate.addingTimeInterval(-1) : event.startDate)
    } else {
        out["start"] = stamp(event.startDate)
        out["end"] = stamp(event.endDate)
    }
    out["location"] = event.location.flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
    out["notes"] = event.notes ?? NSNull()
    out["url"] = event.url?.absoluteString ?? NSNull()
    out["timeZone"] = event.timeZone?.identifier ?? NSNull()
    out["organizer"] = event.organizer.map(serializeParticipant) ?? NSNull()
    out["myStatus"] = (event.attendees ?? []).first(where: { $0.isCurrentUser })
        .map { participantStatusName($0.participantStatus) } ?? NSNull()
    out["recurrence"] = event.recurrenceRules?.first.map(serializeRule) ?? NSNull()
    out["occurrence"] = occurrenceKey(event) ?? NSNull()
    out["created"] = event.creationDate.map(stamp) ?? NSNull()
    out["modified"] = event.lastModifiedDate.map(stamp) ?? NSNull()
    return out
}

func serializeCalendar(_ cal: EKCalendar, defaultId: String?) -> [String: Any] {
    var out: [String: Any] = [
        "id": cal.calendarIdentifier,
        "title": cal.title,
        "account": cal.source?.title ?? "",
        "type": calendarTypeName(cal.type),
        "isDefault": cal.calendarIdentifier == defaultId,
        "readOnly": !cal.allowsContentModifications,
    ]
    out["color"] = colorHex(cal.cgColor) ?? NSNull()
    return out
}

// MARK: - Calendar: lookup and fields

func requireEvent(_ id: String) throws -> EKEvent {
    let notFound = HelperError(code: "event_not_found", message: "No event with id \(id).")
    guard let split = id.range(of: "::", options: .backwards) else {
        guard let event = store.event(withIdentifier: id) else { throw notFound }
        return event
    }

    let base = String(id[..<split.lowerBound])
    let key = String(id[split.upperBound...])
    let when = try parseInstant(key)
    // A moved occurrence keeps its original date as the key, so search a
    // generous window around it rather than the exact day.
    let window: TimeInterval = 31 * 86_400
    let predicate = store.predicateForEvents(
        withStart: when.addingTimeInterval(-window), end: when.addingTimeInterval(window), calendars: nil
    )
    guard let match = store.events(matching: predicate).first(where: {
        $0.eventIdentifier == base && occurrenceKey($0) == key
    }) else { throw notFound }
    return match
}

func parseSpan(_ value: Any?) throws -> EKSpan {
    switch value as? String {
    case nil, "this": return .thisEvent
    case "future": return .futureEvents
    default: throw invalid("span must be this or future.")
    }
}

/// `YYYY-MM-DD` is all-day; a time is read in the event's own time zone.
func parseEventTime(_ text: String, in zone: TimeZone) throws -> (date: Date, allDay: Bool) {
    var components = try parseDue(text)
    let allDay = components.hour == nil
    if allDay {
        components.hour = 0
        components.minute = 0
    } else {
        components.timeZone = zone
    }
    guard let date = calendar.date(from: components) else { throw invalid("Invalid date \"\(text)\".") }
    return (date, allDay)
}

/// Same patch rules as reminders: absent leaves a field alone, null clears it.
func applyEvent(_ fields: [String: Any], to event: EKEvent, isNew: Bool) throws {
    if let name = fields["timeZone"] as? String {
        guard let zone = TimeZone(identifier: name) else {
            throw invalid("Unknown time zone \"\(name)\". Use an IANA name like America/New_York.")
        }
        event.timeZone = zone
    }
    let zone = event.timeZone ?? TimeZone.current

    if let title = fields["title"] as? String {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw invalid("title cannot be empty.")
        }
        event.title = title
    }

    if let reference = fields["calendar"] as? String {
        let target = try resolveCalendar(reference, for: .event)
        guard target.allowsContentModifications else {
            throw HelperError(code: "read_only", message: "The calendar \(describeList(target)) is read-only.")
        }
        event.calendar = target
    }

    if fields.keys.contains("location") { event.location = fields["location"] as? String }
    if fields.keys.contains("notes") { event.notes = fields["notes"] as? String }

    if fields.keys.contains("url") {
        if let text = fields["url"] as? String {
            guard let url = URL(string: text), url.scheme != nil else { throw invalid("Invalid url \"\(text)\".") }
            event.url = url
        } else {
            event.url = nil
        }
    }

    if let availability = fields["availability"] as? String {
        event.availability = try availabilityValue(availability)
    }

    let oldStart: Date? = event.startDate
    let oldEnd: Date? = event.endDate
    let oldAllDay = event.isAllDay
    let endText = fields["end"] as? String

    if let startText = fields["start"] as? String {
        let (start, allDay) = try parseEventTime(startText, in: zone)
        event.isAllDay = allDay
        event.startDate = start
        if endText == nil {
            // Moving an event keeps its length; a new one gets an hour, or one day.
            if !isNew, allDay == oldAllDay, let oldStart, let oldEnd {
                event.endDate = start.addingTimeInterval(oldEnd.timeIntervalSince(oldStart))
            } else {
                event.endDate = allDay ? start : start.addingTimeInterval(3600)
            }
        }
    }

    if let endText {
        guard let start = event.startDate else { throw invalid("start is required.") }
        let (end, allDay) = try parseEventTime(endText, in: zone)
        guard allDay == event.isAllDay else {
            throw invalid("start and end must both be dates (all-day) or both be date-times.")
        }
        guard end >= start else { throw invalid("end is before start.") }
        event.endDate = end
    }

    if fields.keys.contains("alarms") {
        let kept = (event.alarms ?? []).filter { $0.structuredLocation != nil }
        let fresh = fields["alarms"] is NSNull ? [] : try buildAlarms(fields["alarms"])
        event.alarms = kept + fresh
    }

    if fields.keys.contains("recurrence") {
        if let rule = fields["recurrence"] as? [String: Any] {
            event.recurrenceRules = [try buildRule(rule)]
        } else {
            event.recurrenceRules = nil
        }
    }
}

// MARK: - Calendar: commands

func commandCalendars() -> Any {
    let defaultId = store.defaultCalendarForNewEvents?.calendarIdentifier
    return store.calendars(for: .event).map { serializeCalendar($0, defaultId: defaultId) }
}

func commandEvents(_ input: [String: Any]) throws -> Any {
    guard let fromText = input["from"] as? String, let toText = input["to"] as? String else {
        throw invalid("from and to are required.")
    }
    let from = try parseInstant(fromText)
    let to = try parseInstant(toText)
    guard to > from else { throw invalid("to must be after from.") }
    let calendars: [EKCalendar]? = try input["calendars"].map {
        try stringArray($0, "calendars").map { try resolveCalendar($0, for: .event) }
    }
    return store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars))
        .map(serializeEvent)
}

func commandEventGet(_ input: [String: Any]) throws -> Any {
    guard let id = input["id"] as? String else { throw invalid("id is required.") }
    return serializeEvent(try requireEvent(id))
}

func commandEventCreate(_ input: [String: Any]) throws -> Any {
    guard input["title"] is String else { throw invalid("title is required.") }
    guard input["start"] is String else { throw invalid("start is required.") }
    guard let fallback = store.defaultCalendarForNewEvents else {
        throw HelperError(code: "calendar_not_found", message: "There is no default calendar. Pass a calendar.")
    }

    let event = EKEvent(eventStore: store)
    event.calendar = fallback
    event.timeZone = TimeZone.current
    try applyEvent(input, to: event, isNew: true)
    try store.save(event, span: .thisEvent, commit: true)
    return serializeEvent(event)
}

func commandEventUpdate(_ input: [String: Any]) throws -> Any {
    guard let id = input["id"] as? String else { throw invalid("id is required.") }
    let span = try parseSpan(input["span"])
    let event = try requireEvent(id)
    var fields = input
    fields.removeValue(forKey: "id")
    fields.removeValue(forKey: "span")
    try applyEvent(fields, to: event, isNew: false)
    try store.save(event, span: span, commit: true)
    return serializeEvent(event)
}

func commandEventDelete(_ input: [String: Any]) throws -> Any {
    let ids = try stringArray(input["ids"], "ids")
    let span = try parseSpan(input["span"])
    let events = try ids.map(requireEvent)
    let snapshot = events.map(serializeEvent)

    for event in events {
        try store.remove(event, span: span, commit: false)
    }
    try store.commit()
    return snapshot
}

func commandCalendarCreate(_ input: [String: Any]) throws -> Any {
    guard let title = input["title"] as? String,
          !title.trimmingCharacters(in: .whitespaces).isEmpty
    else {
        throw invalid("title is required.")
    }

    let source: EKSource
    if let account = input["account"] as? String {
        let candidates = store.sources.filter {
            $0.title.caseInsensitiveCompare(account) == .orderedSame && !$0.calendars(for: .event).isEmpty
        }
        guard let match = candidates.first else {
            let names = Set(store.calendars(for: .event).compactMap { $0.source?.title }).sorted().joined(separator: ", ")
            throw HelperError(code: "account_not_found", message: "No calendar account named \"\(account)\". Accounts: \(names).")
        }
        source = match
    } else {
        guard let fallback = store.defaultCalendarForNewEvents?.source else {
            throw HelperError(code: "account_not_found", message: "There is no default calendar account. Pass an account.")
        }
        source = fallback
    }

    let cal = EKCalendar(for: .event, eventStore: store)
    cal.title = title
    cal.source = source
    if let color = input["color"] as? String {
        cal.cgColor = try parseColor(color)
    }
    try store.saveCalendar(cal, commit: true)
    return serializeCalendar(cal, defaultId: store.defaultCalendarForNewEvents?.calendarIdentifier)
}

func commandCalendarDelete(_ input: [String: Any]) throws -> Any {
    guard let reference = input["calendar"] as? String else { throw invalid("calendar is required.") }
    let cal = try resolveCalendar(reference, for: .event)
    guard !cal.isImmutable else {
        throw HelperError(code: "read_only", message: "The calendar \(describeList(cal)) cannot be deleted.")
    }
    let snapshot = serializeCalendar(cal, defaultId: store.defaultCalendarForNewEvents?.calendarIdentifier)
    try store.removeCalendar(cal, commit: true)
    return snapshot
}

// MARK: - Entry point

let calendarCommands: Set<String> = [
    "calendars", "events", "event_get", "event_create", "event_update", "event_delete",
    "calendar_create", "calendar_delete",
]

func run(_ command: String, _ input: [String: Any]) throws -> Any {
    // status must work without access, or there is no way to diagnose a denial.
    if command == "status" {
        return accessSummary()
    }
    if command == "authorize" {
        // Ask for each independently, so declining one still prompts for the other.
        for type in [EKEntityType.reminder, .event] {
            try? requireAccess(type)
        }
        return accessSummary()
    }

    try requireAccess(calendarCommands.contains(command) ? .event : .reminder)
    switch command {
    case "lists": return commandLists()
    case "fetch": return try commandFetch(input)
    case "get": return try commandGet(input)
    case "create": return try commandCreate(input)
    case "update": return try commandUpdate(input)
    case "set_completed": return try commandSetCompleted(input)
    case "delete": return try commandDelete(input)
    case "create_list": return try commandCreateList(input)
    case "calendars": return commandCalendars()
    case "events": return try commandEvents(input)
    case "event_get": return try commandEventGet(input)
    case "event_create": return try commandEventCreate(input)
    case "event_update": return try commandEventUpdate(input)
    case "event_delete": return try commandEventDelete(input)
    case "calendar_create": return try commandCalendarCreate(input)
    case "calendar_delete": return try commandCalendarDelete(input)
    default: throw invalid("Unknown command \"\(command)\".")
    }
}

// MARK: - Responsibility

// macOS charges privacy access to the "responsible" app: whatever launched the
// process tree. Claude.app declares no Calendar or Reminders usage text, so
// requests made on its behalf are refused without a prompt. Re-launching
// ourselves with responsibility disclaimed makes this helper its own
// responsible process, using the usage text in its embedded Info.plist, and
// one grant then holds whichever app starts the server.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let disclaimedMarker = "MAC_HELPER_DISCLAIMED"

func relaunchDisclaimed() -> Never {
    guard let path = Bundle.main.executablePath else {
        respond(["ok": false, "code": "internal", "message": "Could not locate the helper executable."])
    }
    var attrs: posix_spawnattr_t?
    posix_spawnattr_init(&attrs)
    defer { posix_spawnattr_destroy(&attrs) }
    _ = responsibility_spawnattrs_setdisclaim(&attrs, 1)

    var env = ProcessInfo.processInfo.environment
    env[disclaimedMarker] = "1"
    let argv = CommandLine.arguments.map { strdup($0) } + [nil]
    let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]

    // stdin, stdout and stderr are inherited, so the child speaks the protocol directly.
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, path, nil, &attrs, argv, envp)
    guard rc == 0 else {
        respond(["ok": false, "code": "internal", "message": "Could not relaunch the helper: \(String(cString: strerror(rc)))."])
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    // Mirror the child's exit so a crash still reads as a crash to the server.
    let signal = status & 0x7F
    exit(signal == 0 ? (status >> 8) & 0xFF : 128 + signal)
}

if ProcessInfo.processInfo.environment[disclaimedMarker] == nil {
    relaunchDisclaimed()
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    respond(["ok": false, "code": "invalid_input", "message": "Usage: mac-helper <command> < input.json"])
}

let raw = FileHandle.standardInput.readDataToEndOfFile()
let input: [String: Any]
if raw.isEmpty {
    input = [:]
} else if let parsed = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] {
    input = parsed
} else {
    respond(["ok": false, "code": "invalid_input", "message": "stdin must be a JSON object."])
}

do {
    respond(["ok": true, "data": try run(arguments[1], input)])
} catch let error as HelperError {
    respond(["ok": false, "code": error.code, "message": error.message])
} catch {
    respond(["ok": false, "code": "eventkit", "message": error.localizedDescription])
}
