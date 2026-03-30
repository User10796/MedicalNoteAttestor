import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            AttestorTabView()
                .tabItem {
                    Label("Attestor", systemImage: "doc.text.magnifyingglass")
                }
            HeidiTabView()
                .tabItem {
                    Label("Heidi", systemImage: "list.clipboard")
                }
        }
        .frame(minWidth: 180, idealWidth: 380, minHeight: 300, idealHeight: 540)
        .padding(12)
    }
}

#Preview {
    ContentView()
}
