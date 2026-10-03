// 负向：`render` 从**外部包** import 进来（gamma.ts 里有个同名的 `render`，但这里**没 import 它**）
// → `use → gamma.ts::render` **不该存在**：这个名字已经有主了，不许回落到同名匹配。
import { render } from '@testing-library/react';

// 正向对照：`Plain` 从 `./alpha` import 进来 → 裸名 `Plain` **必须**接得上 `alpha.ts::Plain`（且是 import 档）。
import { Plain } from './alpha';

export const use = () => {
    render();
    return Plain;
};
