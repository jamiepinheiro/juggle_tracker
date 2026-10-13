import Charts
import SwiftUI

/// Stats for one finished session: the end-of-session summary and the history detail.
struct SessionStatsView: View {
    let session: SessionRecord
    let previousBest: Int?          // set on the summary, to call out a new personal best

    var body: some View {
        if session.runs.isEmpty {
            ContentUnavailableView("No throws counted",
                                   systemImage: "circle.dotted",
                                   description: Text("Nothing was saved. Check that the camera sees the whole arc of each throw, with the device held still."))
        } else {
            VStack(alignment: .leading, spacing: 24) {
                headline
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading, spacing: 18) {
                    stat("Runs (drops)", "\(session.runs.count)")
                    stat("Average run", String(format: "%.1f", session.averageRun))
                    stat("Median run", String(format: "%g", session.medianRun))
                    stat("Total throws", "\(session.totalThrows)")
                    stat("Session time", formatDuration(session.duration))
                    stat("Time juggling", formatDuration(session.timeJuggling))
                    stat("Longest run", String(format: "%.1f s", session.longestRunTime))
                    stat("Throw rate", session.throwRate.map { String(format: "%.1f /s", $0) } ?? "–")
                }
                runsChart
            }
        }
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Best run").font(.subheadline).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(session.bestRun)")
                    .font(.system(size: 64, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text(session.bestRun == 1 ? "throw" : "throws").font(.title3).foregroundStyle(.secondary)
            }
            if let previousBest, session.bestRun > previousBest {
                Text(previousBest > 0 ? "New personal best, up from \(previousBest)" : "Your first personal best")
                    .font(.headline)
                    .foregroundStyle(Color.accentColor)
            }
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2.weight(.semibold)).monospacedDigit()
            Text(label).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var runsChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Throws in each run, in order").font(.headline)
            Chart(Array(session.runs.enumerated()), id: \.offset) { i, run in
                BarMark(x: .value("Run", i + 1), y: .value("Throws", run.throwCount))
                    .foregroundStyle(run.throwCount == session.bestRun ? Color.accentColor : Color.secondary.opacity(0.5))
                    .annotation(position: .top) {
                        if session.runs.count <= 20 || run.throwCount == session.bestRun {
                            Text("\(run.throwCount)").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
            }
            .chartXAxis(.hidden)
            .chartYAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
            .frame(height: 180)
        }
    }
}
