;;; sample.el --- 样例 -*- lexical-binding: t; -*-

(defvar my-counter 0
  "计数器。")

(defun my-double (x)
  "把 X 翻倍。"
  (* x 2))

(provide 'sample)
