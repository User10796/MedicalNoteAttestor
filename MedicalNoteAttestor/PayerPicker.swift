import SwiftUI
import AppKit

// Payer picker + procedure confirmation, shown after a capture (macOS twin of picker.html).
// Typeahead over payer names + aliases; the 10 most recent payers are pinned (1-9, 0).
// Nothing is highlighted until Sterling types or arrows: a reflexive Return can't pick
// last patient's payer. Esc = Skip = paste exactly as today. Everything runs locally.

struct PickerAnswer {
    let payerId: String
    let rows: [DetectedRow]
}

@MainActor
final class PayerPickerModel: ObservableObject {
    @Published var query = "" { didSet { selection = query.trimmingCharacters(in: .whitespaces).isEmpty ? -1 : 0; refresh() } }
    @Published var matches: [PayerHit] = []
    @Published var selection = -1
    @Published var payer: PayerHit?
    @Published var rows: [DetectedRow]
    @Published var notices: [Resolution] = []
    @Published var inserts: [Resolution] = []   // what will be added (preview)
    let noneDetected: Bool
    let procedures: [RegistryProcedure]
    let sessionLastPayerName: String?
    private let recents: [String]
    private let core = MNACore.shared
    var finish: (PickerAnswer?) -> Void = { _ in }

    init(detection: Detection, recents: [String], sessionLastPayer: String?) {
        self.recents = recents
        self.noneDetected = detection.noneDetected
        self.rows = detection.items.isEmpty ? [DetectedRow(procedure_id: nil, laterality: "bilateral", checked: true)] : detection.items
        self.procedures = MNACore.shared.procedures().sorted { $0.name < $1.name }
        self.sessionLastPayerName = sessionLastPayer.flatMap { id in MNACore.shared.searchPayers(query: "", recents: [id]).first?.name }
        refresh()
    }

    var pinned: [PayerHit] { matches.filter { $0.pinned } }

    func refresh() { matches = core.searchPayers(query: query, recents: recents) }

    func choose(_ hit: PayerHit?) {
        guard let hit else { return }
        payer = hit
        refreshNotices()
    }
    /// A digit only highlights that recent payer; Return confirms (a stray digit can't pick one).
    func highlightRecent(_ n: Int) {
        guard query.isEmpty else { return }
        let i = n == 0 ? 9 : n - 1
        if i < pinned.count, let idx = matches.firstIndex(of: pinned[i]) { selection = idx }
    }
    func move(_ delta: Int) {
        guard !matches.isEmpty else { return }
        selection = max(0, min(matches.count - 1, selection + delta))
    }
    func procedure(_ id: String?) -> RegistryProcedure? { procedures.first { $0.procedure_id == id } }

    func refreshNotices() {
        guard let payer else { notices = []; inserts = []; return }
        let results = core.resolve(payerId: payer.payer_id, rows: rows.filter { $0.procedure_id != nil })
        notices = results.filter { $0.notice != nil }
        inserts = results.filter { $0.insert }
    }
    func setProcedure(_ uid: UUID, _ id: String?) {
        guard let i = rows.firstIndex(where: { $0.uid == uid }) else { return }
        rows[i].procedure_id = id
        rows[i].variant = nil
        rows[i].checked = id != nil
        if let p = procedure(id), !p.laterality_options.contains(rows[i].laterality) {
            rows[i].laterality = p.laterality_options.contains("bilateral") ? "bilateral" : (p.laterality_options.first ?? "bilateral")
        }
        refreshNotices()
    }
    func insert() {
        guard let payer else { return }
        finish(PickerAnswer(payerId: payer.payer_id, rows: rows.filter { $0.procedure_id != nil }))
    }
    func skip() { finish(nil) }
}

private let variantLabels = [
    "radiculopathy_cervical": "Radiculopathy (cervical)", "radiculopathy_thoracic": "Radiculopathy (thoracic)",
    "radiculopathy_lumbar": "Radiculopathy (lumbar)", "pdn": "Painful diabetic neuropathy",
    "pslps": "Failed back (PSLPS)", "chronic_back_pain": "Chronic back pain"
]
private let lateralityLabels = ["bilateral": "Bilateral", "right": "Right", "left": "Left", "midline": "Midline"]

struct PayerPickerView: View {
    @ObservedObject var model: PayerPickerModel
    @FocusState private var queryFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.payer == nil { payerStep } else { procedureStep }
        }
        .padding(12)
        .frame(minWidth: 480, minHeight: 360, alignment: .topLeading)
        .onExitCommand { model.skip() }
    }

    private var payerStep: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Payer").font(.headline)
            TextField("Type payer name or alias (e.g. Medicare, BCBS, PSHP)", text: $model.query)
                .textFieldStyle(.roundedBorder)
                .focused($queryFocused)
                .onSubmit { if model.selection >= 0, model.selection < model.matches.count { model.choose(model.matches[model.selection]) } }
                .onKeyPress(.downArrow) { model.move(1); return .handled }
                .onKeyPress(.upArrow) { model.move(-1); return .handled }
                .onKeyPress(characters: .decimalDigits) { press in
                    guard model.query.isEmpty, let n = Int(press.characters) else { return .ignored }
                    model.highlightRecent(n); return .handled
                }
            ScrollViewReader { proxy in
                List(Array(model.matches.enumerated()), id: \.element.id) { i, hit in
                    HStack {
                        Text(hit.pinned && model.query.isEmpty ? String((model.pinned.firstIndex(of: hit)! + 1) % 10) : " ")
                            .font(.caption).foregroundColor(.secondary).frame(width: 14, alignment: .trailing)
                        Text(hit.name)
                        Spacer()
                        if hit.pinned { Text("recent").font(.caption2).foregroundColor(.orange) }
                    }
                    .padding(.vertical, 1)
                    .listRowBackground(i == model.selection ? Color.accentColor.opacity(0.25) : Color.clear)
                    .contentShape(Rectangle())
                    .onTapGesture { model.choose(hit) }
                    .id(i)
                }
                .onChange(of: model.selection) { _, s in if s >= 0 { proxy.scrollTo(s) } }
            }
            if let last = model.sessionLastPayerName {
                Text("Last payer this session: \(last) (not pre-selected)").font(.caption).foregroundColor(.secondary)
            }
            Text("Return = choose · 1–9, 0 then Return = recent payer · Esc = Skip (paste as usual, no library text)")
                .font(.caption).foregroundColor(.secondary)
            HStack { Button("Skip (Esc)") { model.skip() }.keyboardShortcut(.cancelAction); Spacer() }
        }
        .onAppear { queryFocused = true }
    }

    private var procedureStep: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Payer: ").foregroundColor(.secondary) + Text(model.payer?.name ?? "").bold()
                Spacer()
                Button("change") { model.payer = nil; model.notices = [] }.buttonStyle(.link)
            }
            if model.noneDetected { Text("No procedure detected. Pick one below, or Skip.").italic().foregroundColor(.secondary) }
            ScrollView {
                VStack(spacing: 6) { ForEach($model.rows) { $row in rowView($row) } }
            }
            Button("+ add procedure") {
                model.rows.append(DetectedRow(procedure_id: nil, laterality: "bilateral", checked: true))
            }.buttonStyle(.link)
            ForEach(model.notices, id: \.procedure_id) { n in
                Text(n.notice ?? "")
                    .font(.caption)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(n.marker == "red" ? Color.red.opacity(0.15) : n.marker == "amber" ? Color.yellow.opacity(0.25) : Color.blue.opacity(0.1))
                    .cornerRadius(4)
            }
            if !model.inserts.isEmpty {
                DisclosureGroup("Preview inserted text (\(model.inserts.count))") {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(model.inserts, id: \.procedure_id) { r in
                                Text(model.procedure(r.procedure_id)?.name ?? r.procedure_id).font(.caption).bold()
                                if !r.examText.isEmpty { Text("F10 exam:\n" + r.examText).font(.system(size: 10, design: .monospaced)) }
                                if !r.dotphrase.isEmpty { Text("F11 dot-phrase:\n" + r.dotphrase).font(.system(size: 10, design: .monospaced)) }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.frame(maxHeight: 180)
                }.font(.caption)
            }
            HStack {
                Button("Skip (Esc)") { model.skip() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Insert (Return)") { model.insert() }.keyboardShortcut(.defaultAction)
            }
        }
    }

    private func rowView(_ row: Binding<DetectedRow>) -> some View {
        let r = row.wrappedValue
        let proc = model.procedure(r.procedure_id)
        return HStack(spacing: 6) {
            Toggle("", isOn: Binding(get: { row.wrappedValue.checked },
                                     set: { row.wrappedValue.checked = $0; model.refreshNotices() })).labelsHidden()
            Picker("", selection: Binding(get: { r.procedure_id ?? "" }, set: { model.setProcedure(r.uid, $0.isEmpty ? nil : $0) })) {
                Text("— pick a procedure —").tag("")
                ForEach(model.procedures) { p in Text(p.name).tag(p.procedure_id) }
            }.labelsHidden()
            if let proc {
                Picker("", selection: Binding(get: { row.wrappedValue.laterality },
                                              set: { row.wrappedValue.laterality = $0; model.refreshNotices() })) {
                    ForEach(proc.laterality_options, id: \.self) { Text(lateralityLabels[$0] ?? $0).tag($0) }
                }.labelsHidden().frame(width: 100)
                if let vs = proc.variants, !vs.isEmpty {
                    Picker("", selection: Binding(get: { row.wrappedValue.variant ?? "" },
                                                  set: { row.wrappedValue.variant = $0.isEmpty ? nil : $0; model.refreshNotices() })) {
                        Text("Indication…").tag("")
                        ForEach(vs, id: \.self) { Text(variantLabels[$0] ?? $0).tag($0) }
                    }.labelsHidden().frame(width: 170)
                }
                if !r.planned && !r.checked { Text("suggested").font(.caption2).foregroundColor(.secondary) }
            }
            Button { model.rows.removeAll { $0.uid == r.uid }; model.refreshNotices() } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
        }
        .padding(6)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(4)
        .opacity(r.checked ? 1 : 0.6)
    }
}

/// Presents the picker in a floating panel and returns the answer (nil = Skip).
@MainActor
final class PayerPickerController {
    static let shared = PayerPickerController()
    private var panel: NSPanel?
    private var continuation: CheckedContinuation<PickerAnswer?, Never>?

    func present(detection: Detection, recents: [String], sessionLastPayer: String?) async -> PickerAnswer? {
        dismiss(with: nil)  // a newer capture replaces an open picker (old one = Skip)
        return await withCheckedContinuation { cont in
            continuation = cont
            let model = PayerPickerModel(detection: detection, recents: recents, sessionLastPayer: sessionLastPayer)
            model.finish = { [weak self] answer in self?.dismiss(with: answer) }
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 440),
                            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            p.title = "Medical Note Attestor — payer & procedures"
            p.level = .floating
            p.isReleasedWhenClosed = false
            p.contentView = NSHostingView(rootView: PayerPickerView(model: model))
            p.center()
            NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: p, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.dismiss(with: nil) }
            }
            panel = p
            NSApp.activate(ignoringOtherApps: true)
            p.makeKeyAndOrderFront(nil)
        }
    }

    private func dismiss(with answer: PickerAnswer?) {
        let c = continuation
        continuation = nil
        if let p = panel { panel = nil; p.orderOut(nil); p.close() }
        c?.resume(returning: answer)
    }
}
