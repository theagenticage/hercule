import { assert, describe, it } from "vitest";
import { createTokenStore, tokenStorageKey, type StorageLike } from "./token-store";

/** An in-memory stand-in for `localStorage`. */
const memoryStorage = (): StorageLike & { readonly map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
};

describe("token store", () => {
  it("keys the token by origin", () => {
    assert.strictEqual(
      tokenStorageKey("http://127.0.0.1:7717"),
      "hercule:token:http://127.0.0.1:7717",
    );
  });

  it("reads back what it wrote, per origin", () => {
    const storage = memoryStorage();
    const here = createTokenStore("http://a.test", storage);
    const there = createTokenStore("http://b.test", storage);

    assert.strictEqual(here.read(), null);
    here.write("tok_a");
    there.write("tok_b");

    assert.strictEqual(here.read(), "tok_a");
    assert.strictEqual(there.read(), "tok_b");
    assert.strictEqual(storage.map.get("hercule:token:http://a.test"), "tok_a");
  });

  it("removes the entry when written null", () => {
    const storage = memoryStorage();
    const store = createTokenStore("http://a.test", storage);
    store.write("tok");
    store.write(null);

    assert.strictEqual(store.read(), null);
    assert.strictEqual(storage.map.has("hercule:token:http://a.test"), false);
  });
});

describe("a browser that denies site data", () => {
  const denied = (): StorageLike => ({
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    removeItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  });

  it("holds no token and swallows the write, rather than throwing at the caller", () => {
    const store = createTokenStore("http://a.test", denied());
    assert.strictEqual(store.read(), null);
    assert.doesNotThrow(() => {
      store.write("tok");
    });
    assert.doesNotThrow(() => {
      store.write(null);
    });
    assert.strictEqual(store.read(), null);
  });
});
