// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IThing.sol";

/// 形状基类：Solidity 用 contract / interface 组织。
contract Shape is IThing {
    string public name;

    constructor(string memory n) {
        name = n;
    }

    /// 面积（虚函数靠 override 实现）
    function area() public virtual returns (uint256) {
        return 0;
    }

    modifier onlyNamed() {
        require(bytes(name).length > 0, "no name");
        _;
    }
}

contract Circle is Shape {
    uint256 public radius;

    constructor(uint256 r) Shape("circle") {
        radius = r;
    }

    function area() public override returns (uint256) {
        return radius > 0 ? 314 * radius * radius / 100 : 0;
    }
}

interface IThing {
    function id() external view returns (uint256);
}
