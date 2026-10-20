import Flutter
import UIKit
import UniformTypeIdentifiers

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  // One-time credential screens (lib/secure_window.dart).
  private let secureWindow = SecureWindowChannel()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "LifeYytConsoleWindow") {
      secureWindow.register(with: registrar.messenger())
    }
  }
}

/// `life.yyt.console/window`, the iOS side of lib/secure_window.dart (Android:
/// MainActivity.kt). iOS cannot block screenshots or recording; while secure,
/// an opaque cover hides the screen from the app switcher snapshot, which iOS
/// takes after the app resigns active. Best effort: verified on a device only.
final class SecureWindowChannel: NSObject {
  private var channel: FlutterMethodChannel?
  private var secure = false
  private var cover: UIView?
  private var observers: [NSObjectProtocol] = []

  func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "life.yyt.console/window", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self = self else {
        result(FlutterMethodNotImplemented)
        return
      }
      self.handle(call, result: result)
    }
    self.channel = channel

    // Application-wide notifications: they fire under the scene life cycle too.
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.showCover() })
    observers.append(
      center.addObserver(
        forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.hideCover() })
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any]
    switch call.method {
    case "setSecure":
      // Every `true` is paired with a `false` by the Dart side.
      secure = (args?["secure"] as? Bool) ?? false
      if !secure {
        hideCover()
      }
      result(nil)

    case "copySensitive":
      let text = (args?["text"] as? String) ?? ""
      // Local only: kept off Universal Clipboard. The pasteboard itself
      // drops the item after two minutes (docs/decisions.md, iOS #6), even
      // with the app suspended; the Dart clearAfterMs is the Android timer.
      let options: [UIPasteboard.OptionsKey: Any] = [
        .localOnly: true,
        .expirationDate: Date().addingTimeInterval(120),
      ]
      UIPasteboard.general.setItems([[UTType.plainText.identifier: text]], options: options)
      result(nil)

    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func showCover() {
    guard secure, cover == nil, let window = keyWindow() else { return }
    let view = UIView(frame: window.bounds)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.backgroundColor = .systemBackground
    window.addSubview(view)
    cover = view
  }

  private func hideCover() {
    cover?.removeFromSuperview()
    cover = nil
  }

  private func keyWindow() -> UIWindow? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    return windows.first(where: { $0.isKeyWindow }) ?? windows.first
  }
}
