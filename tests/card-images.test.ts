// tests/card-images.test.ts
import { test, expect } from "bun:test";
import { imagesIn, imageMarkdown, appendImage, removeImage } from "../src/ui/cardImages";

test("imagesIn finds every image token in order", () => {
  const text = "before\n\n![shot.png](/tmp/up/a-shot.png)\n\n![two](/tmp/up/b.jpg) after";
  expect(imagesIn(text)).toEqual([
    { token: "![shot.png](/tmp/up/a-shot.png)", alt: "shot.png", src: "/tmp/up/a-shot.png" },
    { token: "![two](/tmp/up/b.jpg)", alt: "two", src: "/tmp/up/b.jpg" },
  ]);
});

test("imagesIn returns nothing for text with no images", () => {
  expect(imagesIn("just a description")).toEqual([]);
});

test("imageMarkdown strips bracket characters that would break the token", () => {
  expect(imageMarkdown("a[weird](name).png", "/tmp/x.png")).toBe("![aweirdname.png](/tmp/x.png)");
});

test("imageMarkdown falls back to a name when there isn't one", () => {
  expect(imageMarkdown("", "/tmp/x.png")).toBe("![image](/tmp/x.png)");
});

test("appendImage puts the first image on its own, with no leading blank", () => {
  expect(appendImage("", "![a](/x.png)")).toBe("![a](/x.png)");
  expect(appendImage("   \n", "![a](/x.png)")).toBe("![a](/x.png)");
});

test("appendImage separates an image from existing prose", () => {
  expect(appendImage("some notes", "![a](/x.png)")).toBe("some notes\n\n![a](/x.png)");
  // trailing whitespace is normalised rather than accumulated
  expect(appendImage("some notes\n\n", "![a](/x.png)")).toBe("some notes\n\n![a](/x.png)");
});

test("removeImage drops the token and collapses the gap it leaves", () => {
  const text = "notes\n\n![a](/x.png)\n\n![b](/y.png)";
  expect(removeImage(text, "![a](/x.png)")).toBe("notes\n\n![b](/y.png)");
  expect(removeImage(text, "![b](/y.png)")).toBe("notes\n\n![a](/x.png)");
});

test("removeImage leaves text untouched when the token isn't there", () => {
  expect(removeImage("notes", "![a](/x.png)")).toBe("notes");
});

test("removing the only image leaves just the prose", () => {
  expect(removeImage("notes\n\n![a](/x.png)", "![a](/x.png)")).toBe("notes");
});

test("the same image attached twice can be removed one at a time", () => {
  const md = imageMarkdown("shot.png", "/tmp/shot.png");
  const text = appendImage(appendImage("", md), md);
  expect(imagesIn(text)).toHaveLength(2);
  expect(imagesIn(removeImage(text, md))).toHaveLength(1);
});
