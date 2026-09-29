// Records how one window first appears, for `first-frame.ts` (see there). It records only that
// window, so nothing else on the screen reaches the files.
//
//     first-frame-recorder <window-id> <width-pt> <height-pt> <out-dir> <record-ms>
//
// <window-id> is the window's number in the window server, as Electron's `getMediaSourceId()`
// gives it. The window must exist, and not be on screen yet. <width-pt> and <height-pt> are its
// size in points: ScreenCaptureKit lists a window that has never been on screen with a size of
// zero, so it cannot tell the recorder how large the frames should be.
//
// It prints one JSON object per line on standard output. Times are milliseconds since the epoch,
// on the machine's clock, the one the app's own performance marks count from.
//
// - {"ready":t}: the recording has started, and the window is checked every millisecond for when
//   it goes on screen.
// - {"frame":n,"at":t,"file":f,"width":w,"height":h}: a frame of the window whose pixels differ
//   from the frame before, written to <out-dir>/<f>.bgra as rows of BGRA bytes with no padding.
//   `at` is when macOS composited the frame.
// - {"onScreen":t}: macOS first reported the window on screen.
// - {"done":true}: <record-ms> after the window went on screen, recording stopped, and every
//   frame was also written as <out-dir>/<f>.png, to look at.
// - {"error":message}: the recording failed; the recorder exits with code 1.
//
// ScreenCaptureKit reads the window's own buffer, not the screen, so what it records is what the
// window holds, whatever animation macOS plays as the window shows. While a window is recorded,
// macOS draws its "window is being shared" indicator over the window's traffic lights.

import AppKit
import CoreImage
import Foundation
import ScreenCaptureKit

let args = CommandLine.arguments
guard args.count == 6, let windowId = CGWindowID(args[1]), let widthPt = Double(args[2]),
  let heightPt = Double(args[3]), let recordMs = Double(args[5])
else {
  FileHandle.standardError.write(
    "usage: first-frame-recorder <window-id> <width-pt> <height-pt> <out-dir> <record-ms>\n".data(using: .utf8)!)
  exit(2)
}
let outDir = URL(fileURLWithPath: args[4])
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
// Connects to the window server; ScreenCaptureKit needs that in a command-line tool.
_ = NSApplication.shared
setvbuf(stdout, nil, _IOLBF, 0)

let printLock = NSLock()

/// Returns the time now, in milliseconds since the epoch.
func readEpochMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// Prints `object` as one line of JSON.
func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  printLock.withLock { print(String(data: data, encoding: .utf8)!) }
}

/// Prints the error and exits with code 1.
func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

/// Receives the stream's frames, and writes each one whose pixels differ from the one before.
final class FrameWriter: NSObject, SCStreamOutput {
  let lock = NSLock()
  var previous: Data?
  var files: [(name: String, width: Int, height: Int)] = []

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
      let pixels = CMSampleBufferGetImageBuffer(buffer)
    else { return }
    // The presentation time is on the host clock; its age converts it to the epoch.
    let presented = CMSampleBufferGetPresentationTimeStamp(buffer)
    let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), presented))
    let at = readEpochMs() - age * 1000

    lock.lock()
    defer { lock.unlock() }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    let width = CVPixelBufferGetWidth(pixels)
    let height = CVPixelBufferGetHeight(pixels)
    let rowBytes = CVPixelBufferGetBytesPerRow(pixels)
    let base = CVPixelBufferGetBaseAddress(pixels)!
    // Rows can be padded; the file holds them packed.
    var packed = Data(count: width * height * 4)
    packed.withUnsafeMutableBytes { target in
      for row in 0..<height {
        memcpy(target.baseAddress! + row * width * 4, base + row * rowBytes, width * 4)
      }
    }
    CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
    if packed == previous { return }
    previous = packed
    let name = String(format: "frame-%03d", files.count + 1)
    do {
      try packed.write(to: outDir.appendingPathComponent("\(name).bgra"))
    } catch {
      fail("could not write \(name).bgra: \(error)")
    }
    files.append((name, width, height))
    emit(["frame": files.count, "at": at, "file": name, "width": width, "height": height])
  }
}

/// When macOS first reported the window on screen, shared between the thread that checks and the
/// recording task.
final class OnScreenTime: @unchecked Sendable {
  private let lock = NSLock()
  private var time: Double?
  func record(_ time: Double) { lock.withLock { self.time = time } }
  func read() -> Double? { lock.withLock { time } }
}

/// Returns whether macOS reports the window as on screen.
func isOnScreen(_ id: CGWindowID) -> Bool {
  let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
  return (info.first?[kCGWindowIsOnscreen as String] as? Bool) ?? false
}

Task {
  guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) else {
    fail("ScreenCaptureKit lists no windows: does this terminal have the Screen Recording permission?")
  }
  guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
    fail("ScreenCaptureKit does not list window \(windowId)")
  }
  if isOnScreen(windowId) { fail("window \(windowId) is already on screen") }

  let filter = SCContentFilter(desktopIndependentWindow: window)
  let scale = CGFloat(filter.pointPixelScale)
  let config = SCStreamConfiguration()
  config.width = Int(widthPt * scale)
  config.height = Int(heightPt * scale)
  config.minimumFrameInterval = CMTime(value: 1, timescale: 120)
  config.pixelFormat = kCVPixelFormatType_32BGRA
  config.showsCursor = false
  config.queueDepth = 8
  let writer = FrameWriter()
  let stream = SCStream(filter: filter, configuration: config, delegate: nil)
  do {
    try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
    try await stream.startCapture()
  } catch {
    fail("could not start recording window \(windowId): \(error)")
  }

  // The on-screen check runs on its own thread, so it keeps its 1 ms pace whatever else runs.
  let deadline = Date().addingTimeInterval(30)
  let onScreen = OnScreenTime()
  Thread.detachNewThread {
    while Date() < deadline {
      if isOnScreen(windowId) {
        let time = readEpochMs()
        onScreen.record(time)
        emit(["onScreen": time])
        return
      }
      usleep(1000)
    }
  }
  emit(["ready": readEpochMs()])

  while onScreen.read() == nil {
    if Date() > deadline { fail("window \(windowId) did not go on screen within 30 s") }
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  try? await Task.sleep(nanoseconds: UInt64(recordMs * 1_000_000))
  try? await stream.stopCapture()

  let context = CIContext()
  let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
  for file in writer.lock.withLock({ writer.files }) {
    guard let data = try? Data(contentsOf: outDir.appendingPathComponent("\(file.name).bgra")) else { continue }
    let image = CIImage(
      bitmapData: data, bytesPerRow: file.width * 4, size: CGSize(width: file.width, height: file.height),
      format: .BGRA8, colorSpace: sRGB)
    try? context.writePNGRepresentation(of: image, to: outDir.appendingPathComponent("\(file.name).png"), format: .RGBA8, colorSpace: sRGB)
  }
  emit(["done": true])
  exit(0)
}
RunLoop.main.run()
