---
jupyter:
  jupytext:
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  kernelspec:
    display_name: Python 3
    language: python
    name: python3
---

<!-- #raw raw_mimetype="text/restructuredtext" -->
.. meta::
   :description: Topic: Math supplement, Difficulty: Easy, Category: Section
   :keywords: sums, sigma notation, python
<!-- #endraw -->

# Sequences and Summations


It is important that we are comfortable with reading and manipulating mathematical formulas that involve sequences and sums, because these topics appear frequently in the world of scientific computing and applied mathematics.
This section will introduce the notation that we will be using for sequences and summations and how we work with these objects in Python.


## Sequence Notation

Before we go into sequences and summations, it is important that we understand the basics of sequences.
Very simply, a sequence is an ordered collection of numbers.
For example, $(0, 1, 2, 3, 4, 5)$ is a sequence containing six items.
The sequence $(0, 2, 3, 1, 5, 4)$ is a different sequence, because although it contains the same elements as the previous sequence, its elements are in a different order.
Elements of a sequence are allowed to repeat.
For example, $(4, 2, 7, 8, 4, 1, 7)$ is a valid sequence.

If we define the sequence 
\begin{equation}
x = (-2, -4, -6, -8, -10, 13),
\end{equation}
then we can access each element by using subscripts (which, similar to Python, begin at 0 and end at $n-1$, where $n$ is the number of elements in the sequence).
Therefore,
\begin{equation}
x_0 = -2,\: x_1 = -4,\: x_2 = -6,\: x_3 = -8,\: x_4 = -10, \:\text{and}\; x_5 = 13.
\end{equation}


The notation $(x_i)_{i=0}^{n-1}$ is often used to represent all of the elements of the sequence $x$.
For our previous example, $(x_i)_{i=0}^{n-1}$ represents $(-2, -4, -6, -8, -10, 13)$.
This notation is useful because it also gives us a way to represent a *subsequence* of $x$.
For example, $(x_i)_{i=0}^{3}$ represents only the first four elements of $x$, $(-2, -4, -6, -8)$, while $(x)_{i=2}^{4}$ would represent only the elements $(-6, -8, -10)$.

<!-- #region -->
## Summation Notation

In order to more efficiently denote sums, especially sums over long sequences, we can use summation notation, also known as sigma notation due to the use of the Greek letter "sigma": $\Sigma$.

There are several elements involved in summation notation.
First, consider a sequence of $n$ numbers $(x_i)_{i=0}^{n-1}$.
We will start our index at 0, to remain in accordance with Python/NumPy's index system, so $x_i$ is the general $(i+1)^\text{th}$ number in the sequence.
We will utilize this $i$ index in our summation notation.
Suppose we were to calculate the sum of all $n$ numbers in the sequence.
We write this sum as

\begin{equation}
x_0+x_1+ \cdots +x_{n-1} = \sum_{i=0}^{n-1} x_i.
\end{equation}

Let's parse this equation.
First, $\Sigma$ is the summation sign, indicating that we are summing a sequence.
Then, $i$ is the index of summation that is being iterated over, with $i$ being used to index $x$.
We start our summation at $0$ because the first element we want in our sum is $x_0$ (the lower bound of the sum is $i=0$).
The upper bound for our sum, or our stopping point is $n-1$, since the final element in our summation is $x_{n-1}$.  
This is indicated by writing $n-1$ on top of the $\Sigma$ symbol.
Finally, $x_i$ indicates the quantity that we are summing.

One way to think about this is in terms of a for-loop.
This summation concept is equivalent to a for-loop over all integers in the range from the lower bound to the upper bound, indexed into the sequence $x$.
Thus, the code for our previous sum is:

```python
total = 0
x = [1, 3, -2, 0, 10]
n = len(x)
for i in range(n): # i = 0, 1, ..., n-1
    total += x[i]
    
# this is equivalent to
total = sum(x)
```

The value of `total` in either case will be $12$.

It is probably easiest to build an intuition by looking through a few more examples of summation notation.

*Example 1:*

\begin{equation}
\sum_{i=1}^{n} i^2= 1 + 4+ \cdots n^2 = \frac{n(n+1)(2n+1)}{6}
\end{equation}

```python
>>> n = 5
>>> sum(i**2 for i in range(1, n + 1))
55
```

*Example 2:*

\begin{equation}
\sum_{i=3}^{6} x_i^2 = x_3^2+x_4^2+x_5^2+x_6^2
\end{equation}

```python
>>> x = [1, 7, 4, 1, 6, 9, 5, 2, 7]
>>> sum(x[i]**2 for i in range(3, 7))
143
```

*Example 3:*

\begin{equation}
\sum_{i=1}^{5} i^2-i = (1-1) + (4-2) + (9-3) + (16-4) + (25-5) =  0+2+6+12+20=40
\end{equation}

```python
>>> sum((i**2 - i) for i in range(1, 6))
40
```

We can also sum over several different sequences.
Consider the sequences $(a_i)_{i=0}^m$ and $(b_j)_{j=0}^n$.
Then, we can calculate the sum of the product of each value in $(a_i)_{i=0}^m$ with each value in $(b_j)_{j=0}^n$ (a sum over $m \times n$ products).
Because the $i$ index only appears in association with $(a_i)_{i=0}^m$, and the $j$ index with $(b_j)_{j=0}^n$, we can group these summations as

\begin{equation}
\sum_{i=0}^{m-1} \sum_{j=0}^{n-1} a_i \cdot b_j = \left(\sum_{i=0}^{m-1} a_i\right) \cdot \left(\sum_{j=0}^{n-1} b_j\right) = (a_0+a_1 + a_2 + \cdots + a_{m-1}) \cdot (b_0 + b_1 + b_2 + \cdots b_{n-1}).
\end{equation}


```python
>>> import numpy as np
>>> A = np.random.rand(5)
>>> B = np.random.rand(7)
>>> sum(A[i]*B[j] for i in range(5) for j in range(7)) == sum(A)*sum(B)
True
```
Note that the following does **not** hold

\begin{equation}
\sum_{i=0}^{m-1} a_i \cdot a_i \neq \left(\sum_{i=0}^{m-1} a_i\right) \cdot \left(\sum_{i=0}^{m-1} a_i\right)
\end{equation}

because this would treat the index $i$ in the first term independently from the $i$ in the second term of the product.
Notice that in the right side of the equation, we could have interchanged the index $i$ in the second summation with $j$, without changing any of the mathematics.
The sum on the left represents the summation of $m$ terms of $a_{i}^2$, whereas the sum on the right represents the summation of $m \times m$ terms - products between all possible pairs of A's terms.


```python
>>> import numpy as np
>>> A = np.random.rand(5)
>>> sum(A[i]*A[i] for i in range(5)) == sum(A)*sum(A)
False
```

Mathematicians are lazy.
This means writing as little as possible to communicate, so note that typically when someone writes $\sum_{i} x_i$, this is just the sum of all values in the sequence $(x_i)_{i=0}^{n-1}$ and is the same as writing $\sum_{i=0}^{n-1} x_i$, where the value of $n$ is known.
<!-- #endregion -->

<div class="alert alert-info">

**Reading Comprehension: Arithmetic Mean**

Using the introduced summation notation, write the mean of a sequence $(x_i)_{i=0}^{n-1}$, which contains $n$ numbers.
    
Next, write a Python function called `mean`, which takes in a collection of numbers (a list, tuple, set, etc.) called `seq` and returns the mean of the sequence using a for-loop.
Use this method to calculate the mean of the tuple `(1, 5, 6, 9, 2, 5, 8, 1)`.

</div>


## Kronecker Delta

To make notation for working with summations even simpler (especially those involving matrices), we can use the Kronecker delta function, named after Prussian mathematician Leopold Kronecker.
We use $\delta_{ij}$ to denote the Kronecker delta function, defined as:

\begin{equation}
\delta_{ij}=\begin{cases}
 0 & \text{if } i \neq j\\    
1 & \text{if } i=j    
\end{cases}
\end{equation}

See that a Kronecker delta can "collapse" a sum. If $j$ be an integer between 0 and $n-1$, then

\begin{equation}
\sum_{i=0}^{n-1} \delta_{ij} a_i = 0 \cdot a_0  + \cdots + 1 \cdot a_j + 0 \cdot a_{j+1}+ \cdots + 0 \cdot  a_{n-1}= a_{j}.
\end{equation}

See also that the identity matrix, $I$, can be written as $I_{ij}=\delta_{ij}$:

\begin{equation}
I = 
\begin{bmatrix}
1   & 0 & \cdot & \cdot & 0  \\
0 & 1 & 0 &  \cdot  & \cdot \\
\cdot & 0 & 1 & 0 & \cdot \\
\cdot & \cdot & 0 & 1 & 0 \\
0 & \cdot & \cdot & 0 & 1 
\end{bmatrix}
\end{equation}



<div class="alert alert-info">

**Reading Comprehension: Kronecker Delta**

Write a function named `kronecker`. 
It should accept two input argument, named `i` and `j`, which will be integers. 
Have the function return $1$ if the arguments are equal and $0$ if they are not equal.

Then, use this function to collapse a sum. 
Make 2 lists of 5 elements each.
The first list, called `a`, should contain the numbers `[3, 6, 7, 1, 8]` and the other list, called `b`, should contain `[4, 7, 1, 3, 8]`.
Use the `kronecker` function to compute and print the sum
\begin{equation}
\sum_{i=0}^{4} a_i \cdot b_i.
\end{equation}

</div>


## Reading Comprehension Exercise Solutions

<!-- #region -->
**Arithmetic Mean: Solution**

The equation for computing the mean of a collection of numbers, using summation notation, is
\begin{equation}
\frac{1}{N} \cdot \sum_{k=0}^{N-1} x_k.
\end{equation}
```python
def mean(seq):
    """
    Parameters
    ----------
    seq : Iterable
    
    Returns
    -------
    float
        The mean of the given sequence
    """
    sum_ = 0
    for num in seq:
        sum_ += num
    return sum_ / len(seq)
```
```python
>>> mean((1, 5, 6, 9, 2, 5, 8, 1))
4.625
```
<!-- #endregion -->

<!-- #region -->
**Kronecker Delta: Solution**

```python
def kronecker(i, j):
    """
    Parameters
    ----------
    i : int
    j : int
    
    Returns
    -------
    int
        returns 1 if `i` and `j` are equal and returns 0 otherwise
    """
    # Recall that `int(True)` returns 1 and `int(False)` returns 0.
    return int(i == j)

a = [3, 6, 7, 1, 8]
b = [4, 7, 1, 3, 8]
print(sum(a[i] * b[j] * kronecker(i, j) for i in range(5) for j in range(5)))
```
<!-- #endregion -->
