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
        .frame(width: 500, height: 400)
        .padding()
    }

    // MARK: - Heidi Copy Tab

    private var heidiCopyTab: some View {
        Form {
            Section {
                Toggle("Enable Heidi Copy Hotkeys", isOn: $settings.heidiCopyEnabled)
                    .toggleStyle(.switch)

                Text("When enabled, global hotkeys will copy HPI or A&P sections from Heidi to your clipboard.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section("Hotkey Configuration") {
                Picker("HPI Section Hotkey:", selection: $settings.hpiHotkey) {
                    ForEach(HotkeyOption.allCases) { option in
                        Text(option.rawValue).tag(option)
                    }
                }
                .pickerStyle(.menu)

                Picker("A&P Section Hotkey:", selection: $settings.apHotkey) {
                    ForEach(HotkeyOption.allCases) { option in
                        Text(option.rawValue).tag(option)
                    }
                }
                .pickerStyle(.menu)

                if settings.hpiHotkey == settings.apHotkey {
                    Text("⚠️ HPI and A&P hotkeys must be different")
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }

            Section("How It Works") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("1. Click into Heidi note window")
                    Text("2. Press the HPI hotkey → HPI copied to clipboard")
                    Text("3. Click into Cerner Powerchart HPI field → Cmd+V")
                    Text("4. Click back into Heidi note")
                    Text("5. Press the A&P hotkey → A&P copied to clipboard")
                    Text("6. Click into Cerner A&P field → Cmd+V")
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    // MARK: - Claude API Tab

    private var claudeAPITab: some View {
        Form {
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
                    Text("• Always include 'Return to clinic in X weeks'")
                    Text("• Format diagnoses in a specific way")
                    Text("• Add specific disclaimers")
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
