// マニュアルの画像(.shots の中)をタップしたときの、拡大表示。
// ※サーバーの安全設定(CSP)で、HTMLの中に直接書いたスクリプトは動かないため、別ファイルにしています。
// 画像(.shots の中)をタップすると、拡大して表示する。
// どこかをタップするか、×ボタン、Escキーで、閉じる。
try {
  const box = document.getElementById("lightbox");
  const big = box.querySelector("img");

  // 開く: タップした画像を、大きい表示に入れ替える
  function openBox(img) {
    big.src = img.currentSrc || img.src;
    big.alt = img.alt || "";
    box.classList.add("open");
    document.body.style.overflow = "hidden"; // 後ろのページが動かないようにする
  }
  // 閉じる
  function closeBox() {
    box.classList.remove("open");
    big.removeAttribute("src");
    document.body.style.overflow = "";
  }

  // 画像が増えても動くように、ページ全体で押されたものを見て判断する
  document.addEventListener("click", function (e) {
    const img = e.target.closest(".shots img");
    if (img) openBox(img);
  });
  // 拡大した画面は、どこを押しても閉じる
  box.addEventListener("click", closeBox);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeBox();
  });
} catch (err) {
  // 拡大表示が動かなくても、マニュアルは読めるようにする
  console.warn("画像の拡大表示を使えませんでした:", err);
}
