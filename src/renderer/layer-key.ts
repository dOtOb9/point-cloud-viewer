// 複数レイヤー（L1-C）: ノードのキャッシュ・ローダーのキーをレイヤーで名前空間に分ける。
//
// COPC のノードキー（"0-0-0-0" など）は、どのファイルにも同じものがある。
// 複数のファイルを同時に開くと衝突するので、レイヤーごとに内部の通し番号（serial）を
// 前に付けて "<serial>:<ノードキー>" にする。
//
// レイヤーの id（呼び出し側が付ける文字列）ではなく通し番号を使う理由:
// 同じ id を removeLayer → addLayer で付け直したとき、前のレイヤー宛ての読み込み結果が
// 後から届いても、通し番号が違うので別のレイヤーのものとして捨てられる。

/** そのレイヤーのキーの前に付ける文字列。 */
export function layerKeyPrefix(serial: number): string {
  return `${serial}:`;
}

export function layerNodeKey(serial: number, nodeKey: string): string {
  return layerKeyPrefix(serial) + nodeKey;
}

/** "<serial>:<ノードキー>" を分ける。この形でなければ null。 */
export function parseLayerNodeKey(key: string): { serial: number; nodeKey: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const serial = Number(key.slice(0, i));
  if (!Number.isInteger(serial)) return null;
  return { serial, nodeKey: key.slice(i + 1) };
}
