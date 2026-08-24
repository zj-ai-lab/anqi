-- 固定案件标题与案件工作区的关系：历史版本以 cases.name 隐式找同名目录，
-- folder_path 虽有字段但没有任何读路径真正使用。升级时把空指针物化一次，
-- 之后改案件标题不再悄悄切换文件/Agent workspace。
UPDATE cases
   SET folder_path = name
 WHERE TRIM(folder_path) = '';
