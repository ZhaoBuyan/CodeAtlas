class Beta {
    func use() -> gamma {
        let alpha = 1
        // `alpha` 当**类型**用一次：引用采集认的是类型位置，值位置的裸名（`print(alpha)`）不进引用表
        let holder: alpha? = nil
        print(alpha, holder as Any)
        return gamma()
    }
}
