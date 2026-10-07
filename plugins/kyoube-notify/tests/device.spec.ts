import { describe, expect, it } from "vitest";
import { deviceLabel, deviceState, keyBytes, readDeviceEnv, sameKey, type DeviceEnv } from "../src/ui/device.js";

const env = (over: Partial<DeviceEnv> = {}): DeviceEnv => ({ secure: true, ios: false, standalone: false, supported: true, permission: "default", ...over });

describe("deviceState", () => {
  it.each([
    [env({ secure: false }), false, "insecure"],
    [env({ ios: true }), false, "ios-install"],
    [env({ ios: true, standalone: true }), false, "off"],
    [env({ supported: false }), false, "unsupported"],
    [env({ permission: "denied" }), false, "denied"],
    [env(), false, "off"],
    [env({ permission: "granted" }), false, "off"],
    [env({ permission: "granted" }), true, "on"],
    [env({ permission: "default" }), true, "off"],
  ] as const)("%o registered=%s → %s", (input, registered, expected) => {
    expect(deviceState(input, registered)).toBe(expected);
  });
});

describe("readDeviceEnv", () => {
  const fakeWindow = (ua: string, over: Record<string, unknown> = {}) => ({
    isSecureContext: true,
    navigator: { userAgent: ua, platform: "iPhone", maxTouchPoints: 5, serviceWorker: {}, standalone: false, ...over },
    matchMedia: () => ({ matches: false }),
    PushManager: function PushManager() {},
    Notification: { permission: "default" },
  }) as unknown as Window;

  it("spots an iPhone outside the Home Screen", () => {
    expect(readDeviceEnv(fakeWindow("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"))).toEqual({ secure: true, ios: true, standalone: false, supported: true, permission: "default" });
    expect(readDeviceEnv(fakeWindow("Mozilla/5.0 (iPhone)", { standalone: true })).standalone).toBe(true);
  });

  it("treats an iPad that reports itself as a Mac as iOS", () => {
    expect(readDeviceEnv(fakeWindow("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", { platform: "MacIntel", maxTouchPoints: 5 })).ios).toBe(true);
  });

  it("is safe to call with no window (server render)", () => {
    expect(readDeviceEnv(undefined)).toEqual({ secure: false, ios: false, standalone: false, supported: false, permission: "default" });
  });
});

describe("helpers", () => {
  it("labels common devices", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141")).toBe("Android phone");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe("Safari on Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
  });

  it("decodes keys and compares them with a subscription's key", () => {
    const key = Buffer.alloc(65, 7); key[0] = 4;
    const b64u = key.toString("base64url");
    expect(Buffer.from(keyBytes(b64u)).equals(key)).toBe(true);
    expect(sameKey(new Uint8Array(key).buffer, b64u)).toBe(true);
    expect(sameKey(new Uint8Array(65).buffer, b64u)).toBe(false);
    expect(sameKey(null, b64u)).toBe(false);
  });
});
