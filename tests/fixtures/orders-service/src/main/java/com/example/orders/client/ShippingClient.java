package com.example.orders.client;

import com.example.orders.exception.ShippingServiceException;
import com.example.orders.model.ShippingInfo;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

@Component
public class ShippingClient {

    private final RestTemplate restTemplate;

    @Value("${shipping.base-url}")
    private String baseUrl;

    public ShippingClient(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public ShippingInfo fetchShipping(String orderId) {
        try {
            return restTemplate.getForObject(baseUrl + "/shipping/{id}", ShippingInfo.class, orderId);
        } catch (RestClientException e) {
            throw new ShippingServiceException("Servicio de envios no disponible", e);
        }
    }
}
