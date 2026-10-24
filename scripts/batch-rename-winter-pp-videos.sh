
# 落咗腳本之後，喺你部 Mac 執行：
cd /private/var/www/html/video-tutor/subjects/chemistry/winter2/pp-videos/2017/

# 試跑（睇吓會做咩，唔會真係執行）
# python3 ~/Downloads/batch_process.py --dry-run

# 正式跑（處理晒所有未完成嘅）
# python3 ~/Downloads/batch_process.py

# 只跑某幾條
# python3 ~/Downloads/batch_process.py --only "2017-PIB"

# 限制 5 條（測試用）
# python3 ~/Downloads/batch_process.py --limit 5


python3 /private/var/www/html/pdf-reader/scripts/batch-rename-winter-pp-videos.py