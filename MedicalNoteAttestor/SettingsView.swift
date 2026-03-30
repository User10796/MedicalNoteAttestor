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
        }
        .frame(width: 500, height: 580)
        .padding()
    }

    // MARK: - Heidi Copy Tab

    private var heidiCopyTab: some View {
        Form {
            Section("Hotkeys") {
                Picker("Capture Note:", selection: $settings.captureHotkey) {
                    ForEach(HotkeyOption.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.menu)

                Picker("Paste HPI (Slot 1):", selection: $settings.pasteHotkey1) {
                    ForEach(HotkeyOption.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.menu)

                Picker("Paste Exam (Slot 2):", selection: $settings.pasteHotkey2) {
                    ForEach(HotkeyOption.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.menu)

                Picker("Paste A/P (Slot 3):", selection: $settings.pasteHotkey3) {
                    ForEach(HotkeyOption.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.menu)

                let all = [settings.captureHotkey, settings.pasteHotkey1,
                           settings.pasteHotkey2, settings.pasteHotkey3]
                if Set(all.map(\.rawValue)).count < all.count {
                    Text("\u{26A0}\u{FE0F} All four hotkeys must be different")
                        .font(.caption).foregroundColor(.red)
                }
            }

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
                    Text("2. Press \(settings.captureHotkey.rawValue) \u{2192} HPI and A/P load automatically")
                    Text("3. Switch to Cerner (one trip):")
                    Text("   \u{2022} Click HPI field \u{2192} \(settings.pasteHotkey1.rawValue) (auto-pastes)")
                    Text("   \u{2022} Click Exam field \u{2192} \(settings.pasteHotkey2.rawValue) (auto-pastes)")
                    Text("   \u{2022} Click A/P field \u{2192} \(settings.pasteHotkey3.rawValue) (auto-pastes + action items)")
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

#Preview {
    SettingsView()
}
