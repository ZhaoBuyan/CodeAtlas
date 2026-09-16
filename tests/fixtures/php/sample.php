<?php

namespace Fixture;

use App\Contracts\ShapeInterface;

/**
 * 形状基类（抽象类 + 接口）。
 */
abstract class Shape implements ShapeInterface
{
    /** @var string 名字 */
    protected string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    abstract public function area(): float;

    protected function internal(): bool
    {
        return $this->name !== '';
    }
}

class Circle extends Shape
{
    private float $radius;

    public function __construct(float $radius)
    {
        parent::__construct('circle');
        $this->radius = $radius;
    }

    public function area(): float
    {
        return $this->radius > 0 ? 3.14 * $this->radius ** 2 : 0.0;
    }
}

interface Drawable
{
    public function draw(): void;
}

enum Color
{
    case Red;
    case Green;
}

function helper(int $a): int
{
    for ($i = 0; $i < $a; $i++) {
        if ($i > 2) {
            return $i;
        }
    }
    return -$a;
}
