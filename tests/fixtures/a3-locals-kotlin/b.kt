class Beta {
    fun use(): gamma {
        val alpha = 1
        // `alpha` 当**类型**用一次：Kotlin 的引用采集只认类型位置（`type_identifier`），
        // 值位置的裸名（`println(alpha)`）本来就不进引用表 —— 要验证 A3 就得用类型位置。
        val holder: alpha? = null
        println(alpha)
        return gamma()
    }
}
