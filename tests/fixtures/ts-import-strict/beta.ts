// 负向（这轮的关键场景）：`render` 是从**外部包** import 进来的，而 `./alpha` **同目录里也有个 render** ——
// `./alpha` 这条相对导入会**路径匹配**上 `alpha.ts`（第 9 轮刚补的解析会让它更准），
// 但"符号名的依据必须来自**引进了这个名字的那条 import**" → 不许拿 `./alpha` 给 `render` 做依据 ✗。
// （第 8 轮撤掉加严，就是因为当时相对目录导入解析不到、一严就误砍真边；第 9 轮补上后才敢开。）
import { render } from '@testing-library/react';

// 正向对照：`Plain` 正是从 `./alpha` 引进来的 → 必须接得上、且是 import 档。
import { Plain } from './alpha';

export const use = () => {
    render();
    return Plain;
};
