
# stop process with listening on port 3101, 3102, 3103, 3104, 3105, 3106, 3107, 3108, 3109, 3110
stop_process() {
	local port="$1"
	local pids

	pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)
	if [ -z "$pids" ]; then
		echo "No listening process found on port $port"
		return 0
	fi

	echo "Stopping process on port $port: $pids"
	kill $pids 2>/dev/null || true
}



stop_process 3001
stop_process 3002