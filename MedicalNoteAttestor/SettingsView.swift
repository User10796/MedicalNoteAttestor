import SwiftUI

struct SettingsView: View {
    @ObservedObject var settings = SettingsManager.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        TabView {
            // Heidi Copy Tab
            heidiCopyTab
                .tabItem {
                    Label("Heidi Copy", systemImage: "doc.on.clipboard")
                }

            // Claude API Tab
            claudeAPITab
                .tabItem {
                    Label("Claude API", systemImage: "brain")
                }

            // Attestation Tab
            attestationTab
                .tabItem {
                    Label("Attestation", systemImage: "doc.text")
                }

            LibrarySettingsTab()
                .tabItem {
                    Label("Criteria Library", systemImage: "books.vertical")
                }

            AboutSettingsTab()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
        }
        .frame(width: 500, height: 580)
        .padding()
    }

    // MARK: - Heidi Copy Tab

    private var heidiCopyTab: some View {
        Form {
            HotkeySettingsSection()

            Section("Capture Timing") {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Delay between captures:")
                        Spacer()
                        Text("\(settings.captureDelay, specifier: "%.1f")s")
                            .foregroundColor(.secondary)
                    }
                    Slider(value: $settings.captureDelay, in: 0.4...1.5, step: 0.1)
                    Text("Increase if slots don't load reliably. Default: 0.7s")
                        .font(.caption).foregroundColor(.secondary)
                }
            }

            Section("Exam Dot Phrase") {
                TextEditor(text: Binding(
                    get: { HeidiSlotManager.shared.examSlot },
                    set: { HeidiSlotManager.shared.saveExamDotPhrase($0) }
                ))
                .frame(height: 120)
                .font(.system(size: 11, design: .monospaced))
                .border(Color.gray.opacity(0.3), width: 1)
                Text("Pre-loaded into Slot 2. Pastes into Cerner Exam field. Persists across sessions.")
                    .font(.caption).foregroundColor(.secondary)
            }

            Section("How It Works") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("1. Open patient note in Heidi")
                    Text("2. Press \(settings.captureHotkey) \u{2192} HPI and A/P load automatically")
                    Text("3. Switch to Cerner (one trip):")
                    Text("   \u{2022} Click HPI field \u{2192} \(settings.pasteHotkey1) (auto-pastes)")
                    Text("   \u{2022} Click Exam field \u{2192} \(settings.pasteHotkey2) (auto-pastes)")
                    Text("   \u{2022} Click A/P field \u{2192} \(settings.pasteHotkey3) (auto-pastes + action items)")
                    Text("4. Save draft. Repeat for next patient.")
                }
                .font(.caption).foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    // MARK: - Claude API Tab

    private var claudeAPITab: some View {
        Form {
            Section("API Key") {
                SecureField("Custom API key (optional)", text: $settings.claudeAPIKey)
                    .font(.system(size: 12, design: .monospaced))
                Text("Leave blank to use the built-in key.")
                    .font(.caption).foregroundColor(.secondary)
            }

            Section("Custom Instructions") {
                Text("Add custom instructions that will be appended to the Claude API prompt when formatting medical notes.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                TextEditor(text: $settings.customClaudeInstructions)
                    .frame(height: 150)
                    .font(.system(size: 12, design: .monospaced))
                    .border(Color.gray.opacity(0.3), width: 1)

                HStack {
                    Spacer()
                    Button("Clear") {
                        settings.resetClaudeInstructions()
                    }
                    .buttonStyle(.borderless)
                }
            }

            Section("Examples") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\u{2022} Always include 'Return to clinic in X weeks'")
                    Text("\u{2022} Format diagnoses in a specific way")
                    Text("\u{2022} Add specific disclaimers")
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    // MARK: - Attestation Tab

    private var attestationTab: some View {
        Form {
            Section("Attestation Template") {
                Text("Customize the attestation template. Use [DYNAMIC_PLAN_TEXT] as a placeholder for the auto-generated plan text.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                TextEditor(text: Binding(
                    get: {
                        settings.customAttestationTemplate.isEmpty
                            ? SettingsManager.defaultAttestationTemplate
                            : settings.customAttestationTemplate
                    },
                    set: { settings.customAttestationTemplate = $0 }
                ))
                    .frame(height: 200)
                    .font(.system(size: 11, design: .monospaced))
                    .border(Color.gray.opacity(0.3), width: 1)

                HStack {
                    Spacer()
                    Button("Reset to Default") {
                        settings.resetAttestationTemplate()
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Hotkeys (press-to-record; changes apply immediately)

struct HotkeySettingsSection: View {
    @State private var draft: [HotkeyAction: String] = [:]
    @State private var recording: HotkeyAction?
    @State private var monitor: Any?
    @State private var errors: [String] = []
    @State private var warnings: [String] = []
    @State private var saved: String?

    var body: some View {
        Section("Hotkeys") {
            ForEach(HotkeyAction.allCases) { action in
                HStack {
                    Text(action.label)
                    Spacer()
                    Button(recording == action ? "Press keys…" : (draft[action] ?? action.defaultBinding)) {
                        recording == action ? stopRecording() : startRecording(action)
                    }
                    .frame(minWidth: 140)
                }
            }
            ForEach(errors, id: \.self) { Text("\u{26A0}\u{FE0F} " + $0).font(.caption).foregroundColor(.red) }
            ForEach(warnings, id: \.self) { Text("\u{26A0}\u{FE0F} " + $0).font(.caption).foregroundColor(.orange) }
            if let saved { Text(saved).font(.caption).foregroundColor(.green) }
            HStack {
                Button("Reset to defaults") {
                    for a in HotkeyAction.allCases { draft[a] = a.defaultBinding }
                    apply()
                }
                Spacer()
                Text("Modifiers allowed (e.g. Ctrl+Shift+F9). Applies immediately.").font(.caption).foregroundColor(.secondary)
            }
        }
        .onAppear { draft = AppDelegate.shared?.hotkeys.bindings() ?? [:] }
        .onDisappear { stopRecording() }
    }

    private func startRecording(_ action: HotkeyAction) {
        stopRecording()
        recording = action
        AppDelegate.shared?.hotkeys.suspend()   // otherwise the current global hotkey swallows the press
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { stopRecording(); return nil } // Esc cancels
            let f = event.modifierFlags
            if let combo = HotkeyBinding.canonical(keyCode: Int(event.keyCode), control: f.contains(.control),
                                                   option: f.contains(.option), shift: f.contains(.shift),
                                                   command: f.contains(.command)) {
                draft[action] = combo
                stopRecording()
                apply()
            }
            return nil
        }
    }

    private func stopRecording() {
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
        if recording != nil { recording = nil; AppDelegate.shared?.hotkeys.resume() }
    }

    private func apply() {
        guard let mgr = AppDelegate.shared?.hotkeys, let v = mgr.save(draft) else { return }
        errors = v.errors.map(\.message)
        warnings = v.warnings.map(\.message)
        if v.ok {
            mgr.reload(force: true)
            let failed = mgr.failed.map(\.label)
            saved = failed.isEmpty
                ? "Active: " + HotkeyAction.allCases.map { "\($0.label) \(mgr.active[$0] ?? "")" }.joined(separator: " · ")
                : "Could not register: " + failed.joined(separator: ", ") + " (taken by macOS or another app)"
            draft = mgr.bindings()
        } else {
            saved = nil
        }
    }
}

// MARK: - Criteria Library

struct LibrarySettingsTab: View {
    @ObservedObject var library = LibraryStore.shared
    @State private var token = ""
    @State private var busy = false

    private var sourceLabel: String {
        ["download": "downloaded", "cache": "local cache", "snapshot": "bundled snapshot", "none": "none"][library.source] ?? library.source
    }

    var body: some View {
        Form {
            Section("Insertion") {
                Toggle("Insert library exam text (F10) and dot-phrases (F11) after capture", isOn: $library.enabled)
                Picker("Dot-phrase position in the A&P", selection: $library.insertion) {
                    Text("End of A&P (default)").tag("end")
                    Text("Right after the procedure plan line").tag("after_plan_line")
                }
            }
            Section("Active library") {
                if library.hasLibrary {
                    Text("Library as of \(library.builtAt.map(formatDate) ?? "—") (release \(library.tag ?? "?"))")
                    Text("Source: \(sourceLabel)").foregroundColor(.secondary)
                } else {
                    Text("No library available").foregroundColor(.red)
                }
                if let err = library.lastError {
                    Text("Last refresh failed: \(err) (using \(sourceLabel))").font(.caption).foregroundColor(.orange)
                }
                if let c = library.lastCheck { Text("Last check: \(c.formatted(date: .omitted, time: .standard))").font(.caption).foregroundColor(.secondary) }
                Button(busy ? "Refreshing…" : "Refresh now") {
                    busy = true
                    Task { await library.refresh(force: true); busy = false }
                }.disabled(busy)
            }
            Section("GitHub token (read-only, pain-criteria-library)") {
                SecureField(library.hasToken ? "Token saved — paste a new one to replace" : "Paste token", text: $token)
                HStack {
                    Button("Save token") {
                        let t = token; token = ""
                        Task { await library.setToken(t) }
                    }.disabled(token.isEmpty)
                    Button("Remove token") { Task { await library.setToken("") } }.disabled(!library.hasToken)
                    Spacer()
                    Text(library.hasToken ? "Token saved in Keychain" : "No token (using cached/bundled library)")
                        .font(.caption).foregroundColor(library.hasToken ? .green : .secondary)
                }
                Text("Stored in the macOS Keychain; never shown again or logged.").font(.caption).foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - About (build stamp)

struct AboutSettingsTab: View {
    @ObservedObject var library = LibraryStore.shared
    @ObservedObject var settings = SettingsManager.shared

    private func info(_ key: String) -> String? {
        let v = Bundle.main.object(forInfoDictionaryKey: key) as? String
        return (v?.isEmpty ?? true) ? nil : v
    }

    var body: some View {
        Form {
            Section("Build") {
                LabeledContent("Version", value: info("CFBundleShortVersionString") ?? "?")
                LabeledContent("Commit", value: info("MNABuildCommit") ?? "dev")
                LabeledContent("Built", value: info("MNABuildTime").map(formatDate) ?? "local dev build")
                LabeledContent("Library snapshot", value: library.snapshotTag ?? "none bundled")
                LabeledContent("Active library", value: "\(library.tag ?? "none") (\(library.source))")
                LabeledContent("Claude model", value: ClaudeAPIClient.model)
            }
            Section("Hotkeys") {
                LabeledContent("Heidi capture", value: settings.captureHotkey)
                LabeledContent("Paste HPI", value: settings.pasteHotkey1)
                LabeledContent("Paste Exam", value: settings.pasteHotkey2)
                LabeledContent("Paste A&P", value: settings.pasteHotkey3)
                LabeledContent("Freed capture", value: settings.freedCaptureHotkey)
            }
        }
        .formStyle(.grouped)
    }
}

private func formatDate(_ iso: String) -> String {
    let f = ISO8601DateFormatter()
    guard let d = f.date(from: iso) else { return iso }
    return d.formatted(date: .abbreviated, time: .shortened)
}

#Preview {
    SettingsView()
}

