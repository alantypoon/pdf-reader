The capture flow now saves intermediate PDF parts as `_1`, `_2`, `_3`, etc. before any part reaches 90% of Chrome's 64 MiB message limit, then merges those parts into the final PDF after capture completes.

add comment to remark the intermittent save as file part as `_1`, `_2`, `_3`, etc. it can actually save a very large file now. 