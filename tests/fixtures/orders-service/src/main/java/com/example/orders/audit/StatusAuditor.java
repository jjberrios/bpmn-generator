package com.example.orders.audit;

import com.example.orders.model.Order;

public interface StatusAuditor {
    void record(Order order);
}
