package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

func environment(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	port := environment("PORT", "8090")
	serviceName := environment("SERVICE_NAME", "go-hello")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]string{"status": "ok", "service": serviceName})
	})
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]string{"message": "Hello from " + serviceName})
	})

	log.Printf("%s listening on :%s", serviceName, port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
