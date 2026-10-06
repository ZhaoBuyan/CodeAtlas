// 正向对照：**有 import** → 裸名 `ScopeWidget` 必须接得上（且是 import 档）。
import { ScopeWidget } from './alpha';

export const use = () => new ScopeWidget();
