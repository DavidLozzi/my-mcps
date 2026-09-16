// mac-helper: a thin JSON bridge between the Node MCP server and EventKit.
//
// Usage: mac-helper <command>   (JSON arguments on stdin, JSON result on stdout)
//
// Every response is a single line: {"ok":true,"data":...} or
// {"ok":false,"code":"...","message":"..."}. The process always exits 0 once it
// has written a response, so a non-zero exit means the helper itself crashed.
//
// Filtering, sorting, and presentation live in the Node server where they can be
// tested without Reminders access. This file only reads and writes the store.

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

func requireAccess() throws {
    let status = EKEventStore.authorizationStatus(for: .reminder)
    switch status {
    case .fullAccess:
        return
    case .notDetermined:
        let (granted, error): (Bool, Error?) = wait { done in
            store.requestFullAccessToReminders { granted, error in done((granted, error)) }
        }
        if granted { return }
        throw HelperError(
            code: "access_denied",
            message: error?.localizedDescription ?? "Reminders access was not granted."
        )
    default:
        throw HelperError(code: "access_denied", message: "Reminders access is \(statusName(status)).")
    }
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

func serializeRule(_ rule: EKRecurrenceRule) -> [String: Any] {
    var out: [String: Any] = ["frequency": frequencyName(rule.frequency), "interval": rule.interval]
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
    let custom = !(rule.daysOfTheWeek ?? []).isEmpty || !(rule.daysOfTheMonth ?? []).isEmpty
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

func resolveList(_ reference: String) throws -> EKCalendar {
    let lists = reminderLists()
    if let exact = lists.first(where: { $0.calendarIdentifier == reference }) {
        return exact
    }

    let wanted = reference.trimmingCharacters(in: .whitespaces)
    let matches = lists.filter { $0.title.caseInsensitiveCompare(wanted) == .orderedSame }
    if matches.count == 1 { return matches[0] }

    if matches.isEmpty {
        let names = lists.map { "\"\($0.title)\"" }.joined(separator: ", ")
        throw HelperError(code: "list_not_found", message: "No reminder list named \"\(reference)\". Lists: \(names).")
    }
    let options = matches.map(describeList).joined(separator: "; ")
    throw HelperError(
        code: "ambiguous_list",
        message: "\(matches.count) lists are named \"\(reference)\": \(options). Pass the list id instead."
    )
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
    return EKRecurrenceRule(recurrenceWith: frequency, interval: interval, end: end)
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

// MARK: - Entry point

func run(_ command: String, _ input: [String: Any]) throws -> Any {
    // status must work without access, or there is no way to diagnose a denial.
    if command == "status" {
        return ["reminders": statusName(EKEventStore.authorizationStatus(for: .reminder))]
    }

    try requireAccess()
    switch command {
    case "authorize": return ["reminders": statusName(EKEventStore.authorizationStatus(for: .reminder))]
    case "lists": return commandLists()
    case "fetch": return try commandFetch(input)
    case "get": return try commandGet(input)
    case "create": return try commandCreate(input)
    case "update": return try commandUpdate(input)
    case "set_completed": return try commandSetCompleted(input)
    case "delete": return try commandDelete(input)
    case "create_list": return try commandCreateList(input)
    default: throw invalid("Unknown command \"\(command)\".")
    }
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
